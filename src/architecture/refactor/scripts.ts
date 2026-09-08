import { buildGraphPageScript } from "../graph/pageScript.js";
import type { RefactorPlan } from "./planner.js";

const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value)).toString("base64");
const helpers = `
import os,stat,re,hashlib

def _r_file_receipt(filename):
    path=os.path.abspath(filename)
    before=os.lstat(path)
    if not stat.S_ISREG(before.st_mode): raise RuntimeError('SAVE_FILE_NOT_REGULAR')
    if before.st_size<=0: raise RuntimeError('SAVE_FILE_EMPTY')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as stream:
        opened=os.fstat(stream.fileno())
        if (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino): raise RuntimeError('SAVE_FILE_REPLACED')
        digest=hashlib.sha256()
        while True:
            chunk=stream.read(1024*1024)
            if not chunk:break
            digest.update(chunk)
        after=os.fstat(stream.fileno())
    final=os.lstat(path)
    if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or (final.st_dev,final.st_ino)!=(before.st_dev,before.st_ino): raise RuntimeError('SAVE_FILE_CHANGED_WHILE_READING')
    return dict(path=path,bytes=after.st_size,sha256=digest.hexdigest(),device=after.st_dev,inode=after.st_ino,mtimeNs=after.st_mtime_ns)

def _r_namespace_empty(requested):
    path=os.path.abspath(requested);folder,name=os.path.split(path)
    if not name.endswith('.toe'): raise RuntimeError('INVALID_SAVE_EXTENSION')
    stem=name[:-4]
    with os.scandir(folder) as entries:
        for entry in entries:
            if entry.name==stem or entry.name.startswith(stem+'.'): raise RuntimeError('NONOVERWRITE_PATH_EXISTS')

def _r_save_copy(requested,original):
    requested=os.path.abspath(requested);folder,name=os.path.split(requested)
    _r_namespace_empty(requested)
    if _r_file_receipt(original['path'])!=original: raise RuntimeError('ORIGINAL_FILE_CHANGED')
    if not project.save(requested,saveExternalToxs=False): raise RuntimeError('COPY_SAVE_FAILED')
    actual=os.path.abspath(os.path.join(project.folder,project.name))
    # Increment/link preferences may create both name.toe and name.1.toe.
    # Accept only a fresh member of this transaction's exact sibling namespace.
    if os.path.dirname(actual)!=folder or not re.fullmatch(re.escape(name[:-4])+r'(?:\\.[0-9]+)?\\.toe',os.path.basename(actual)): raise RuntimeError('ACTIVE_COPY_NOT_CONFIRMED')
    files=[_r_file_receipt(path) for path in dict.fromkeys([requested,actual])]
    if any((f['device'],f['inode'])==(original['device'],original['inode']) for f in files): raise RuntimeError('SAVE_ALIASES_ORIGINAL')
    if _r_file_receipt(original['path'])!=original: raise RuntimeError('ORIGINAL_FILE_CHANGED')
    return dict(requested=requested,actual=actual,files=files)

def _r_all():
    todo=[op('/')]; found=[]
    while todo:
        n=todo.pop();found.append(n);todo.extend(getattr(n,'children',()))
        if len(found)>5000: raise RuntimeError('READ_SET_LIMIT')
    return found

def _r_sources(conn, originals, depth=0):
    if depth>12: raise RuntimeError('BOUNDARY_ROUTE_DEPTH')
    owner=conn.owner
    if owner.id in originals: return [(owner.id,conn.index)]
    out=getattr(conn,'outOP',None)
    if out is not None:
        return [v for c in out.inputConnectors[0].connections for v in _r_sources(c,originals,depth+1)]
    for port in getattr(owner.parent(),'inputConnectors',()):
        inside=getattr(port,'inOP',None)
        if inside is not None and inside.id==owner.id:
            return [v for c in port.connections for v in _r_sources(c,originals,depth+1)]
    raise RuntimeError('UNKNOWN_GENERATED_BOUNDARY_OPERATOR')

def _r_check_wires(wires, nodes):
    originals=set(nodes)
    expected={}
    for edge in wires:
        key=(edge['targetId'],edge['inputIndex'])
        expected.setdefault(key,[]).append((edge['sourceId'],edge['outputIndex']))
    for target,node in nodes.items():
        for port in getattr(node,'inputConnectors',()):
            key=(target,port.index)
            if port.connections and key not in expected: raise RuntimeError('UNEXPECTED_ORIGINAL_INPUT_WIRE')
    for (target,index),wanted in expected.items():
        actual=[v for c in nodes[target].inputConnectors[index].connections for v in _r_sources(c,originals)]
        if actual!=wanted: raise RuntimeError('BOUNDARY_WIRE_ORDER_CHANGED:'+str((target,index)))

def _r_collapse(parent, selected, name):
    before={n.id for n in parent.children}
    for child in parent.children: child.selected=child in selected
    selected[-1].current=True
    if not selected[-1].current: raise RuntimeError('COLLAPSE_CURRENT_NOT_SELECTED')
    candidate=parent.collapseSelected()
    added=[n for n in parent.children if n.id not in before]
    if len(added)!=1: raise RuntimeError('NATIVE_COLLAPSE_CONTAINER_AMBIGUOUS')
    container=added[0]
    if candidate is not None and candidate.id!=container.id: raise RuntimeError('NATIVE_COLLAPSE_RETURN_MISMATCH')
    container.name=name
    if container.name!=name: raise RuntimeError('CONTAINER_NAME_CHANGED')
    return container

def _r_canary():
    if str(app.build) not in ('202533230','2025.33230'): raise RuntimeError('UNTESTED_TD_BUILD')
    host=op('/');name='_mcp_refactor_canary_'+uuid.uuid4().hex
    previous=[(n,n.selected,getattr(n,'current',False)) for n in host.children]
    fixture=None;fixture_id=None
    try:
        fixture=host.create(baseCOMP,name);fixture_id=fixture.id
        original={};wires=[];moving=[];moving_ids=[]
        families=[('CHOP',constantCHOP,nullCHOP),('TOP',constantTOP,nullTOP),('SOP',boxSOP,nullSOP),('DAT',tableDAT,nullDAT),('POP',pointgeneratorPOP,nullPOP)]
        for family,sourceType,filterType in families:
            a=fixture.create(sourceType,'source_'+family);b=fixture.create(filterType,'first_'+family);c=fixture.create(filterType,'second_'+family);d=fixture.create(filterType,'sink_'+family)
            b.inputConnectors[0].connect(a.outputConnectors[0]);c.inputConnectors[0].connect(b.outputConnectors[0]);d.inputConnectors[0].connect(c.outputConnectors[0])
            chain=[a,b,c,d];original.update({n.id:n for n in chain});moving.extend([b,c]);moving_ids.extend([b.id,c.id])
            wires.extend(dict(sourceId=chain[i].id,targetId=chain[i+1].id,outputIndex=0,inputIndex=0) for i in range(3))
        # Regression: native collapse may also sweep an unselected current OP.
        # Start on the unselected sink; the helper must make a selected OP current.
        d.current=True
        untouched={n.id:n.path for n in original.values() if n not in moving}
        box=_r_collapse(fixture,moving,'wrapped')
        if [n.id for n in moving]!=moving_ids or any(n.parent().id!=box.id for n in moving): raise RuntimeError('CANARY_IDS_CHANGED')
        if any(not original[id].valid or original[id].id!=id or original[id].path!=path for id,path in untouched.items()): raise RuntimeError('CANARY_UNSELECTED_CURRENT_SWEPT')
        _r_check_wires(wires,original)
        for n in moving:n.selected=True
        moving[-1].current=True
        if not all(n.selected for n in moving) or not moving[-1].current: raise RuntimeError('CANARY_SELECTION_RESTORE_FAILED')
        return dict(passed=True,build=str(app.build),familiesTested=[f[0] for f in families],idsPreserved=True,boundaryOrderPreserved=True,selectionRestorable=True,unselectedCurrentNotSwept=True,receiptId=uuid.uuid4().hex)
    finally:
        if fixture is not None and fixture.valid and fixture.id==fixture_id: fixture.destroy()
        for n,selected,current in previous:
            if n.valid:n.selected=selected
        for n,selected,current in previous:
            if n.valid and current:n.current=True
`;
export function buildCanaryScript() {
	return `import json,uuid\n${helpers}\nresult=json.dumps(_r_canary())`;
}
export function buildStageScript(
	plan: RefactorPlan,
	checkpoint: string,
	staged: string,
): string {
	const scan = buildGraphPageScript({
		dependencyAnalysis: true,
		items: [],
		rootPath: "/",
	});
	const scanDefinitions = scan.slice(
		0,
		scan.indexOf("for _gi, _gitem in enumerate"),
	);
	return `${scanDefinitions}\n${helpers}\n_rp=json.loads(base64.b64decode("${encode({ checkpoint, plan, staged })}"))
_rplan=_rp['plan'];_rid=_rplan['id']
_rrecords=getattr(_gm,'refactor_transactions',{})
_gm.refactor_transactions=_rrecords
if _rid in _rrecords:
    result=json.dumps(_rrecords[_rid])
else:
    import os
    _rr=dict(id=_rid,state='running',checkpoint=_rp['checkpoint'],checkpointRequested=_rp['checkpoint'],staged=_rp['staged'],stagedRequested=_rp['staged'],sessionId=_gm.session_id,phase='preflight')
    _rrecords[_rid]=_rr
    _rsaved=[]
    try:
        if _gm.session_id!=_rplan['sessionId'] or _gm.graph_project_id!=_rplan['projectId']: raise RuntimeError('STALE_SESSION_OR_PROJECT')
        if os.path.abspath(_gp)!=os.path.abspath(_rplan['projectPath']): raise RuntimeError('ACTIVE_PROJECT_CHANGED')
        _rnodes={n.id:n for n in _r_all()}
        if set(_rnodes)!={e['id'] for e in _rplan['readSet']}: raise RuntimeError('GRAPH_OPERATOR_SET_CHANGED')
        for expected in _rplan['readSet']:
            node=_rnodes[expected['id']]
            if node.path!=expected['path'] or _gnode(node)['fingerprint']!=expected['fingerprint']: raise RuntimeError('STALE_OPERATOR:'+expected['path'])
        _ractual=[]
        for n in _rnodes.values():
            for kind,attribute in [('wire','inputConnectors'),('component-wire','inputCOMPConnectors')]:
                for port in getattr(n,attribute,()):
                    for link in port.connections:_ractual.append((kind,link.owner.path,link.index,n.path,port.index))
        _rwanted=[(e['kind'],e['source'],e['outputIndex'],e['target'],e['inputIndex']) for e in _rplan['wireCensus']]
        if sorted(_ractual)!=sorted(_rwanted): raise RuntimeError('STALE_WIRE_CENSUS')
        _rsaved=[(n,n.selected,getattr(n,'current',False)) for n in _rnodes.values()]
        _rerrors={n.id:n.errors() for n in _rnodes.values()}
        _rby_path={n.path:n for n in _rnodes.values()}
        _rids_by_path={n.path:n.id for n in _rnodes.values()}
        _rwires=[dict(sourceId=_rby_path[e['source']].id,targetId=_rby_path[e['target']].id,inputIndex=e['inputIndex'],outputIndex=e['outputIndex']) for e in _rplan['wireCensus'] if e['kind']=='wire']
        _r_namespace_empty(_rp['checkpoint']);_r_namespace_empty(_rp['staged'])
        _roriginal=_r_file_receipt(_rplan['projectPath'])
        _rr['originalFile']=_roriginal
        _rr['phase']='checkpoint'
        _rr['checkpointSave']=_r_save_copy(_rp['checkpoint'],_roriginal)
        _rr['checkpoint']=_rr['checkpointSave']['actual']
        if set(n.id for n in _r_all())!=set(_rnodes) or any(not n.valid or n.path!=path or n.id!=_rids_by_path[path] for path,n in _rby_path.items()): raise RuntimeError('GRAPH_CHANGED_DURING_SAVE')
        if any(_gnode(_rnodes[e['id']])['fingerprint']!=e['fingerprint'] for e in _rplan['readSet']): raise RuntimeError('SOURCE_CHANGED_DURING_SAVE')
        _rafter_save=[(kind,link.owner.path,link.index,n.path,port.index) for n in _rnodes.values() for kind,attribute in [('wire','inputConnectors'),('component-wire','inputCOMPConnectors')] for port in getattr(n,attribute,()) for link in port.connections]
        if sorted(_rafter_save)!=sorted(_rwanted): raise RuntimeError('WIRES_CHANGED_DURING_SAVE')
        _rr['phase']='canary';_rr['canary']=_r_canary()
        _rr['phase']='collapse'
        parent=op(_rplan['parentPath']);selected=[_rby_path[p] for p in _rplan['input']['paths']]
        if parent is None or parent.op(_rplan['input']['name']) is not None: raise RuntimeError('TARGET_CONTAINER_CHANGED')
        container=_r_collapse(parent,selected,_rplan['input']['name'])
        for oldPath,n in _rby_path.items():
            newPath=(_rplan['containerPath']+oldPath[len(_rplan['parentPath']):]) if oldPath in _rplan['affectedPaths'] else oldPath
            if not n.valid or n.id!=_rids_by_path[oldPath] or n.path!=newPath or op(newPath).id!=n.id: raise RuntimeError('MOVED_ID_OR_PATH_CHANGED')
        for repair in _rplan['repairs']:
            owner=_rby_path[repair['owner']];par=getattr(owner.par,repair['parameter'])
            if str(par.mode).split('.')[-1].lower()!='constant' or not par.isOP: raise RuntimeError('REFERENCE_MODE_CHANGED')
            par.val=' '.join(repair['targetsAfter'])
            if [n.path for n in par.evalOPs()]!=repair['targetsAfter']: raise RuntimeError('CONSTANT_REFERENCE_REPAIR_FAILED')
        _r_check_wires(_rwires,_rnodes)
        for n in _rnodes.values():
            if n.errors()!=_rerrors[n.id]: raise RuntimeError('ERROR_BASELINE_CHANGED:'+n.path)
        for generated in [container]+container.findChildren():
            if generated.id not in _rnodes and generated.errors(): raise RuntimeError('GENERATED_CONTAINER_ERRORS')
        _rr['containerPath']=container.path
        _rr['generatedPorts']=[dict(direction=direction,index=c.index,operator=getattr(c,attribute).path if getattr(c,attribute,None) is not None else None) for direction,attribute,connectors in [('in','inOP',container.inputConnectors),('out','outOP',container.outputConnectors)] for c in connectors]
        _rr['phase']='verified'
    except Exception as exc:
        _rr.update(state='failed',error=str(exc),activeProjectAtFailure=os.path.abspath(os.path.join(project.folder,project.name)),recovery='Checkpoint retained; active copy may contain partial unsaved changes. Reload checkpoint explicitly; do not retry this transaction.')
    finally:
        for n,selected,current in _rsaved:
            if n.valid:n.selected=selected
        for n,selected,current in _rsaved:
            if n.valid and current:n.current=True
    if _rr['state']=='running':
        try:
            _rr['stagedSave']=_r_save_copy(_rp['staged'],_roriginal)
            _rr['staged']=_rr['stagedSave']['actual']
            if any(_r_file_receipt(f['path'])!=f for f in _rr['checkpointSave']['files']): raise RuntimeError('CHECKPOINT_FILE_CHANGED')
            _rr.update(state='complete',phase='saved')
        except Exception as exc:_rr.update(state='failed',error=str(exc),activeProjectAtFailure=os.path.abspath(os.path.join(project.folder,project.name)),recovery='Checkpoint retained; verified in-memory copy was not saved successfully.')
    result=json.dumps(_rr)
`;
}
