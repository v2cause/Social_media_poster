// The form encoding of the Stripe API: nested objects as a[b][c]=v, arrays as a[0]=v. The fake
// Stripe decodes it the way Stripe does, so the parameters the SDK sends can be checked.

export type FormValue = string | FormObject | FormValue[];
export interface FormObject {
  [key: string]: FormValue;
}

const keysOf = (name: string): string[] => {
  const first = name.indexOf('[');
  if (first === -1) {
    return [name];
  }
  const rest = name.slice(first).match(/\[([^\]]*)\]/g) ?? [];
  return [name.slice(0, first), ...rest.map((part) => part.slice(1, -1))];
};

/** Turns objects whose keys are all indexes into arrays, all the way down. */
const withArrays = (value: FormValue): FormValue => {
  if (typeof value === 'string' || Array.isArray(value)) {
    return value;
  }
  const keys = Object.keys(value);
  const entries = keys.map((key) => [key, withArrays(value[key] ?? '')] as const);
  if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
    return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, entry]) => entry);
  }
  return Object.fromEntries(entries);
};

export function decodeForm(body: string): FormObject {
  const root: FormObject = {};
  for (const [name, value] of new URLSearchParams(body)) {
    const keys = keysOf(name);
    let node: FormObject = root;
    keys.forEach((named, index) => {
      // a[]=v appends, like a[0]=v.
      const key = named === '' ? String(Object.keys(node).length) : named;
      if (index === keys.length - 1) {
        node[key] = value;
        return;
      }
      const next = node[key];
      if (typeof next !== 'object' || Array.isArray(next)) {
        node[key] = {};
      }
      node = node[key] as FormObject;
    });
  }
  return withArrays(root) as FormObject;
}
