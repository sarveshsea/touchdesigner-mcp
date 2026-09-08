import { z } from "zod";

const fixtureParams = z.strictObject({
	action: z.enum(["create", "populate", "sample", "cleanup"]),
	batchSize: z.number().int().min(1).max(100).default(100),
	count: z.union([z.literal(1000), z.literal(10000)]),
	offset: z.number().int().min(0).max(9999).default(0),
	owner: z.string().regex(/^[a-f0-9]{32}$/),
	parentPath: z
		.string()
		.regex(/^\/(?:[A-Za-z0-9_]+\/?)*$/)
		.max(512)
		.default("/project1"),
	rootId: z.number().int().nonnegative().nullable().optional(),
});
export type FixtureParams = z.input<typeof fixtureParams>;
/** Only the exact nonce-owned subtree is mutated. Cleanup refuses ID reuse,
 * unknown children and unexpected nested contents; it never saves a project. */
export function buildFixtureScript(input: FixtureParams): string {
	const params = fixtureParams.parse(input);
	const encoded = Buffer.from(JSON.stringify(params)).toString("base64");
	return `import base64,json,math
_bq=json.loads(base64.b64decode("${encoded}"))
_bname='__td_mcp_live_bench_'+_bq['owner']
_bpath=_bq['parentPath'].rstrip('/')+'/'+_bname
_br=op(_bpath)
_bkey='td_mcp_benchmark_owner'
def _bcheck():
    if _br is None or _br.fetch(_bkey,None)!=_bq['owner']:
        raise RuntimeError('BENCHMARK_OWNERSHIP_MISMATCH')
    if _bq.get('rootId') is not None and _br.id!=_bq['rootId']:
        raise RuntimeError('BENCHMARK_IDENTITY_MISMATCH')
def _bnumber(value):
    return value if isinstance(value,(int,float)) and math.isfinite(value) else None
def _bmetric(node,name):
    try:
        return _bnumber(getattr(node,name,None))
    except Exception:
        return None
if _bq['action']=='create':
    if _br is not None:
        raise RuntimeError('BENCHMARK_TARGET_EXISTS')
    _bp=op(_bq['parentPath'])
    if _bp is None:
        raise RuntimeError('BENCHMARK_PARENT_MISSING')
    _br=_bp.create(td.baseCOMP,_bname)
    _br.store(_bkey,_bq['owner'])
    _br.allowCooking=False
    _br.viewer=False
    result=json.dumps(dict(rootId=_br.id))
elif _bq['action']=='cleanup' and _br is None:
    result=json.dumps(dict(done=True,removed=0,remaining=0))
else:
    _bcheck()
    if _bq['action']=='populate':
        _boffset=_bq['offset']
        _bend=min(_bq['count']-1,_boffset+_bq['batchSize'])
        for _bi in range(_boffset,_bend):
            _bn='n_'+str(_bi).zfill(5)
            if _br.op(_bn) is not None:
                raise RuntimeError('BENCHMARK_CHILD_EXISTS')
            _bkind=_bi%20
            _btype={0:td.constantCHOP,2:td.selectCHOP,3:td.textDAT,4:td.baseCOMP}.get(_bkind,td.nullCHOP)
            _bnod=_br.create(_btype,_bn)
            _bnod.store(_bkey,_bq['owner'])
            _bnod.viewer=False
            _bnod.nodeX=(_bi%25)*140
            _bnod.nodeY=-(_bi//25)*100
            _bsrc=_br.op('n_'+str(_bi-_bkind).zfill(5))
            if _bkind==2:
                _bnod.par.chop=_bsrc.path
            elif _bkind==3:
                _bnod.text='op('+repr(_bsrc.path)+')'
            elif _bkind not in (0,4):
                _bprev=_bsrc if _bkind in (1,5) else _br.op('n_'+str(_bi-1).zfill(5))
                _bnod.inputConnectors[0].connect(_bprev)
        result=json.dumps(dict(created=_bend-_boffset,nextOffset=_bend))
    elif _bq['action']=='sample':
        _bsample=[_br]+list(_br.children)[:32]
        _bpassive=getattr(td,'passive',lambda value:value)
        _bsample=[_bpassive(value) for value in _bsample]
        def _bsum(name):
            values=[_bmetric(value,name) for value in _bsample]
            return sum(v for v in values if v is not None) if any(v is not None for v in values) else None
        result=json.dumps(dict(sampledOperators=len(_bsample),fixtureCookingDisabled=not _br.allowCooking,
            rootCpuCookMs=_bmetric(_bsample[0],'cpuCookTime'),rootChildrenCpuCookMs=_bmetric(_bsample[0],'childrenCPUCookTime'),
            sampledCpuCookMsSum=_bsum('cpuCookTime'),sampledTotalCooks=_bsum('totalCooks'),
            sampledCpuBytes=_bsum('cpuMemory'),sampledGpuBytes=_bsum('gpuMemory')))
    elif _bq['action']=='cleanup':
        _bchildren=list(_br.children)[:_bq['batchSize']]
        for _bchild in _bchildren:
            if _bchild.fetch(_bkey,None)!=_bq['owner'] or len(getattr(_bchild,'children',())):
                raise RuntimeError('BENCHMARK_FOREIGN_CONTENTS')
        for _bchild in _bchildren:
            _bchild.destroy()
        _bremaining=len(_br.children)
        if not _bchildren and not _bremaining:
            _br.destroy()
        result=json.dumps(dict(done=op(_bpath) is None,removed=len(_bchildren),remaining=_bremaining))
`;
}
