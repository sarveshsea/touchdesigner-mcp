/** Read registry metadata only. Never instantiate a class to discover support. */
const REGISTRY = `import json
import td
from itertools import islice
_catalog_cap = 8192
_catalog_types = {}
_catalog_families = []
_catalog_truncated = False
_catalog_visits = 0
def _catalog_add(candidate, family=None, key=None):
    global _catalog_truncated, _catalog_visits
    _catalog_visits += 1
    if _catalog_visits > _catalog_cap * 2:
        _catalog_truncated = True
        return
    name = key if isinstance(key, str) else getattr(candidate, 'opType', None)
    if not isinstance(name, str):
        name = getattr(candidate, '__name__', None)
    if isinstance(candidate, str):
        name = candidate
        candidate = getattr(td, name, None)
    if isinstance(name, str) and name:
        if name not in _catalog_types and len(_catalog_types) >= _catalog_cap:
            _catalog_truncated = True
            return
        previous = _catalog_types.get(name)
        _catalog_types[name] = (candidate, family if family is not None else (previous[1] if previous else None))
_registry_families = getattr(td, 'families', {})
if isinstance(_registry_families, dict):
    if len(_registry_families) > 128:
        _catalog_truncated = True
    for _family, _members in islice(_registry_families.items(), 128):
        if not isinstance(_family, str):
            continue
        _catalog_families.append(_family)
        try:
            for _member in islice(iter(_members), max(0, _catalog_cap * 2 + 1 - _catalog_visits)):
                _catalog_add(_member, _family)
        except TypeError:
            pass
_registry_types = getattr(td, 'opTypes', ())
if isinstance(_registry_types, dict):
    for _key, _member in islice(_registry_types.items(), _catalog_cap + 1):
        _catalog_add(_member, key=_key)
else:
    try:
        for _member in islice(iter(_registry_types), _catalog_cap + 1):
            _catalog_add(_member)
    except TypeError:
        pass
_catalog_names = sorted(_catalog_types)
_catalog_build = str(getattr(td.app, 'version', 'unknown')) + '.' + str(getattr(td.app, 'build', 'unknown'))
`;

export function catalogHeaderScript(): string {
	return `${REGISTRY}\n# CATALOG_HEADER\nresult = json.dumps({'build': _catalog_build, 'families': sorted(set(_catalog_families)), 'registryCount': len(_catalog_names), 'truncated': _catalog_truncated})`;
}

export function catalogPageScript(offset: number, limit = 128): string {
	if (
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset > 8192 ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 128
	)
		throw new Error("Invalid catalog page");
	return `${REGISTRY}
_catalog_entries = []
for _name in _catalog_names[${offset}:${offset + limit}]:
    _cls, _family = _catalog_types[_name]
    _row = {'opType': _name}
    if isinstance(_family, str):
        _row['family'] = _family
    for _field in ('opType', 'family', 'label', 'subType', 'isFilter', 'isSupported', 'supported', 'minInputs', 'maxInputs', 'minOutputs', 'maxOutputs', 'isMultiInputs'):
        try:
            _value = getattr(_cls, _field, None)
        except Exception:
            continue
        if _field == 'supported' and not (type(_value) in (bool, int) and _value in (0, 1)):
            continue
        if type(_value) in (str, bool, int):
            _row[_field] = _value
    _catalog_entries.append(_row)
result = json.dumps({'build': _catalog_build, 'entries': _catalog_entries, 'nextOffset': ${offset + limit} if ${offset + limit} < len(_catalog_names) else None, 'truncated': _catalog_truncated})`;
}
