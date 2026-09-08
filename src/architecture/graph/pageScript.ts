import { z } from "zod";

export const graphWorkItemSchema = z.object({
	expandOnly: z.boolean().optional(),
	offset: z.number().int().min(0).max(1_000_000).optional(),
	path: z
		.string()
		.min(1)
		.max(2048)
		.refine((v) => !v.includes("\0")),
	wireAttribute: z.enum(["inputConnectors", "inputCOMPConnectors"]).optional(),
	wireOffset: z.number().int().min(0).max(1000000).optional(),
});
export type GraphWorkItem = z.infer<typeof graphWorkItemSchema>;
const paramsSchema = z.strictObject({
	dependencyAnalysis: z.boolean().default(false),
	items: z.array(graphWorkItemSchema).max(500),
	pageSize: z.number().int().min(1).max(500).default(100),
	rootPath: z
		.string()
		.min(1)
		.max(2048)
		.refine((v) => v.startsWith("/") && !v.includes("\0")),
});

/** Every page is stateless except process/session identity shared with the observer.
 * No OP storage, parameter writes, arbitrary evaluation or forced cooking occurs.
 * Native children/pars access can materialize a TD collection; subsequent work is bounded.
 */
export function buildGraphPageScript(
	input: z.input<typeof paramsSchema>,
): string {
	const parsed = paramsSchema.parse(input);
	for (const item of parsed.items) {
		if (
			item.path !== parsed.rootPath &&
			!item.path.startsWith(
				parsed.rootPath === "/" ? "/" : `${parsed.rootPath}/`,
			)
		)
			throw new Error("Out of scope graph work item");
	}
	const payload = Buffer.from(JSON.stringify(parsed)).toString("base64");
	return `import ast, base64, hashlib, json, math, os, posixpath, re, sys, time, types, uuid
from itertools import islice
_gq = json.loads(base64.b64decode("${payload}"))
_gr = op(_gq['rootPath'])
if _gr is None:
    raise ValueError('GRAPH_ROOT_NOT_FOUND')
_gm = sys.modules.get('_td_mcp_architecture')
if _gm is None:
    _gm = types.ModuleType('_td_mcp_architecture')
    sys.modules['_td_mcp_architecture'] = _gm
if not getattr(_gm, 'session_id', None):
    _gm.session_id = str(uuid.uuid4())
# Stable project namespace is path-based; operator IDs remain runtime-only.
# normcase folds Windows paths only. POSIX case is preserved because macOS can
# use case-sensitive volumes; do not silently merge distinct projects.
_gp = os.path.normcase(os.path.realpath(os.path.join(
    str(getattr(project, 'folder', '')), str(getattr(project, 'name', '')))))
_gidentity = (_gp, getattr(op('/'), 'id', None))
_gprior_identity = getattr(_gm, 'graph_project_identity', None)
if _gprior_identity is not None and _gprior_identity[1] != _gidentity[1]:
    _gm.session_id = str(uuid.uuid4())
_gm.graph_project_identity = _gidentity
_gm.graph_project_id = hashlib.sha256(('td-project-path-v1:' + _gp).encode('utf-8')).hexdigest()
_go = dict(sessionId=_gm.session_id, projectId=_gm.graph_project_id, projectPath=_gp,
    build=str(getattr(app, 'build', 'unknown')), nodes=[], edges=[], discovered=[], pending=[],
    missing=[], warnings=[], dependencyComplete=True, truncated=False,
    dirtyRevision=getattr(_gm, 'dirty_revision', None))
_gstart = time.monotonic()
_gsource_budget = 131072
_ghash_budget = 4194304
_gsource_cache = {}
_ghashed_sources = set()

def _gw(message, structural=False):
    if message not in _go['warnings'] and len(_go['warnings']) < 30:
        _go['warnings'].append(message)
    if structural:
        _go['truncated'] = True
    else:
        _go['dependencyComplete'] = False

def _gt(value, limit=2048):
    text = str(value)
    if len(text) > limit:
        _gw('A metadata field exceeded its bounded length', True)
    return text[:limit]

def _gn(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return 0

def _gh(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

def _ge(kind, source, target, evidence='observed', **extra):
    item = dict(kind=kind, source=source, target=target, evidence=evidence, **extra)
    item['id'] = _gh(json.dumps(item, sort_keys=True))
    if len(_go['edges']) < 4096:
        _go['edges'].append(item)
    else:
        _gw('Page edge capacity exceeded', True)

def _gresolve(owner, value):
    # Global Python op() resolves from the containing COMP, not inside the node.
    path = posixpath.normpath(value if value.startswith('/') else posixpath.dirname(owner.path) + '/' + value)
    target = op(path)
    return target.path if target is not None else None

def _gsource(node, entry, source, key, kind, parameter=''):
    global _gsource_budget, _ghash_budget
    if not isinstance(source, str) or not source:
        return
    if len(source)>4194304:
        _gw('Source hash census capacity exceeded')
        return
    digest = _gh(source)
    if digest not in _ghashed_sources:
        if len(source)>_ghash_budget:
            _gw('Source hash census capacity exceeded')
            return
        _ghash_budget -= len(source)
        _ghashed_sources.add(digest)
    entry['sourceHashes'][key] = digest
    _ge(kind, node.path, node.path, 'unresolved', parameter=parameter, reason='Source semantics require a reference adapter')
    if not _gq['dependencyAnalysis']:
        return
    if digest not in _gsource_cache:
        targets = []
        if len(source)>65536 or len(source)>_gsource_budget:
            message='Static source analysis budget reached; hash and opaque dependency retained'
            if message not in _go['warnings']:
                _go['warnings'].append(message)
        else:
            _gsource_budget -= len(source)
            try:
                tree = ast.parse(source)
                for part in islice(ast.walk(tree),4096):
                    if isinstance(part,ast.Call) and isinstance(part.func,ast.Name) and part.func.id=='op' and len(part.args)==1:
                        arg=part.args[0]
                        if isinstance(arg,ast.Constant) and isinstance(arg.value,str) and len(arg.value)<=2048:
                            targets.append(arg.value)
            except (SyntaxError,ValueError,RecursionError):
                message='Source is opaque to bounded Python static analysis'
                if message not in _go['warnings']:
                    _go['warnings'].append(message)
        _gsource_cache[digest]=targets
    for literal in _gsource_cache[digest]:
        target=_gresolve(node,literal)
        if target:
            _ge(kind,target,node.path,'static',parameter=parameter,reason='Literal candidate only; source is not executed')

def _gparameters(node, entry):
    try:
        pars = node.pars()
    except Exception:
        _gw('Parameter enumeration unavailable')
        return
    if len(pars) > 512:
        _gw('Parameter capacity exceeded')
    for par in islice(pars, 512):
        try:
            _gparameter(node, entry, par)
        except Exception:
            _gw('A parameter could not be inspected without evaluation')

def _gparameter(node, entry, par):
    name = _gt(par.name, 128)
    mode = str(getattr(par, 'mode', '')).split('.')[-1].lower()
    is_op = bool(getattr(par, 'isOP', False))
    ref = dict(name=name, mode=mode, targetPaths=[], evidence='observed')
    if mode == 'constant':
        value = par.val
        if is_op and value not in (None, ''):
            if hasattr(value, 'path'):
                tokens = [value.path]
            elif isinstance(value, str) and len(value) <= 8192:
                tokens = value.split()
            else:
                tokens = []
                ref.update(evidence='unresolved', reason='Unsupported constant OP representation')
            if len(tokens) > 64 or any(re.fullmatch(r'[A-Za-z0-9_./]+', token) is None for token in tokens):
                tokens = []
                ref.update(evidence='unresolved', reason='Pattern or excessive OP references')
            if tokens:
                # Guarded CONSTANT mode and literal-only bounded paths: no expression evaluation.
                try:
                    targets = par.evalOPs()
                    if len(targets) > 64 or len(targets) != len(tokens):
                        ref.update(evidence='unresolved', reason='Constant target count did not match')
                    for target in islice(targets,64):
                        ref['targetPaths'].append(target.path)
                        _ge('parameter', target.path, node.path, parameter=name)
                except Exception:
                    ref.update(evidence='unresolved', reason='Constant target did not resolve')
            entry['parameterReferences'].append(ref)
            if ref['evidence'] == 'unresolved':
                _ge('parameter',node.path,node.path,'unresolved',parameter=name,reason=ref.get('reason','Unresolved constant reference'))
        owner_kind = {'clone':'clone', 'externaltox':'external-tox'}.get(name.lower())
        if owner_kind and value not in (None, ''):
            entry['ownership'].append(owner_kind)
            _ge('ownership', node.path, node.path, 'unresolved', parameter=name, reason=owner_kind)
    elif mode in ('expression', 'bind', 'export'):
        kind = {'expression':'expression', 'bind':'binding', 'export':'export'}[mode]
        ref.update(evidence='unresolved', reason=kind + ' requires semantic adapter')
        entry['parameterReferences'].append(ref)
        source = getattr(par, 'bindExpr' if mode == 'bind' else 'expr', '') if mode != 'export' else ''
        if source:
            _gsource(node, entry, source, name + ':' + mode, kind, name)
        else:
            _ge(kind, node.path, node.path, 'unresolved', parameter=name, reason=ref['reason'])
    else:
        _gw('Unknown parameter mode')
    # UI/default expressions also change meaning when ancestors change.
    for attribute in ('enableExpr', 'defaultExpr', 'defaultBindExpr'):
        source = getattr(par, attribute, '')
        if source:
            _gsource(node, entry, source, name + ':' + attribute, 'expression', name)

def _gwires(node,attribute,kind,offset):
    ports=getattr(node,attribute,())
    end=min(len(ports),offset+64)
    for index,port in enumerate(islice(ports,offset,end),offset):
        links=getattr(port,'connections',())
        if len(links)>128:
            _gw('Wire fanout capacity exceeded',True)
        for link in islice(links,128):
            source=getattr(link,'owner',None) or getattr(link,'ownerOP',None)
            if source is None:
                _gw('Wire owner unavailable',True)
                continue
            _ge(kind,source.path,node.path,inputIndex=int(getattr(port,'index',index)),outputIndex=int(getattr(link,'index',0)))
    if end<len(ports):
        _go['pending'].append(dict(path=node.path,wireAttribute=attribute,wireOffset=end))

def _gnode(node):
    family = str(node.family).upper()
    canonical_type = str(getattr(node,'opType','') or getattr(node,'type','unknown'))
    if not canonical_type.upper().endswith(family):
        canonical_type += family
    entry = dict(id=node.id, path=_gt(node.path), parentPath=posixpath.dirname(node.path),
        name=_gt(node.name, 512), family=_gt(family, 32), opType=_gt(canonical_type, 128),
        subType=_gt(getattr(node, 'subType', ''), 128), tags=[_gt(t,128) for t in islice(getattr(node,'tags',()),64)],
        nodeX=_gn(getattr(node,'nodeX',0)), nodeY=_gn(getattr(node,'nodeY',0)),
        nodeWidth=_gn(getattr(node,'nodeWidth',0)), nodeHeight=_gn(getattr(node,'nodeHeight',0)),
        flags={name: bool(getattr(node,name)) if hasattr(node,name) else None for name in
            ('allowCooking','bypass','lock','viewer','display','render','cloneImmune','componentCloneImmune','isPrivate','isPanel','isObject')},
        ownership=[], parameterReferences=[], sourceHashes={})
    entry['flags']['docked'] = bool(getattr(node,'dock',None))
    if entry['flags']['docked']:
        entry['ownership'].append('docked')
    lower_type = entry['opType'].lower()
    if 'replicator' in lower_type:
        entry['ownership'].append('replicator')
    if entry['flags']['isPrivate']:
        entry['ownership'].append('protected')
    if entry['flags']['lock']:
        entry['ownership'].append('locked-output')
    if len(getattr(node,'storage',{})):
        entry['ownership'].append('runtime-cache')
    for kind in entry['ownership']:
        _ge('ownership',node.path,node.path,'unresolved',reason=kind)
    if node.path != _gq['rootPath']:
        _ge('containment', entry['parentPath'], node.path)
    for attribute,kind in (('inputConnectors','wire'),('inputCOMPConnectors','component-wire')):
        _gwires(node,attribute,kind,0)
    _gparameters(node, entry)
    if (lower_type in ('textdat','text') or 'execute' in lower_type) and entry['family'].upper() == 'DAT':
        if _gq['dependencyAnalysis']:
            try:
                source = getattr(node,'text','')
            except Exception:
                source = ''
                _gw('Text DAT source unavailable')
            if source:
                entry['ownership'].append('source-code')
                _gsource(node,entry,source,'DAT:text','expression')
        else:
            _gw('DAT source analysis was not requested')
    if entry['family'].upper()=='DAT' and lower_type in ('filein','fileindat','webclient','webclientdat'):
        entry['ownership'].append('external-source')
        _ge('ownership',node.path,node.path,'unresolved',reason='External DAT source was not executed or read')
    entry['fingerprint'] = _gh(json.dumps(entry,sort_keys=True))
    return entry

for _gi, _gitem in enumerate(_gq['items']):
    if _gi and (time.monotonic()-_gstart > 0.02 or len(_go['nodes']) >= _gq['pageSize']):
        _go['pending'].extend(_gq['items'][_gi:])
        break
    _gop = op(_gitem['path'])
    if _gop is None:
        _go['missing'].append(_gitem['path'])
        continue
    if _gitem.get('wireAttribute'):
        _ga=_gitem['wireAttribute']
        _gwires(_gop,_ga,'wire' if _ga=='inputConnectors' else 'component-wire',_gitem.get('wireOffset',0))
        continue
    if not _gitem.get('expandOnly',False):
        _go['nodes'].append(_gnode(_gop))
    try:
        _gchildren = getattr(_gop,'children',())
    except Exception:
        _gchildren = ()
        _gw('Child enumeration unavailable',True)
    _goffset = _gitem.get('offset',0)
    _gcapacity = max(0,_gq['pageSize']-len(_go['discovered']))
    for _gchild in islice(_gchildren,_goffset,_goffset+_gcapacity):
        _go['discovered'].append(dict(path=_gt(_gchild.path)))
    _gnext = _goffset + min(_gcapacity,max(0,len(_gchildren)-_goffset))
    if _gnext < len(_gchildren):
        _go['pending'].append(dict(path=_gop.path,offset=_gnext,expandOnly=True))
_go['scanStats']=dict(pythonMs=round((time.monotonic()-_gstart)*1000,3),hashedSources=len(_ghashed_sources),hashChars=4194304-_ghash_budget,analysisChars=131072-_gsource_budget)
_go['endDirtyRevision'] = getattr(_gm,'dirty_revision',None)
result = json.dumps(_go,allow_nan=False)
`;
}
