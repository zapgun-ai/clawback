export function canonicalize(obj) {
	return JSON.stringify(obj, (_key, value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const sorted = {};
			for (const k of Object.keys(value).sort()) sorted[k] = value[k];
			return sorted;
		}
		return value;
	});
}
