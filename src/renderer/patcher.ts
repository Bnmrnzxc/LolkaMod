type Method = (...args: any[]) => any;
type Around = (args: any[], next: (...args: any[]) => any, self: any) => any;
type Layer = { owner: string; around: Around };
type Cell = { original: Method; descriptor?: PropertyDescriptor; wrapper: Method; layers: Layer[] };
const cells = new WeakMap<object, Map<PropertyKey, Cell>>();

export function instead(owner: string, object: any, key: PropertyKey, around: Around): () => void {
  let methods = cells.get(object);
  if (!methods) { methods = new Map(); cells.set(object, methods); }
  let cell = methods.get(key);
  if (cell && object[key] !== cell.wrapper) { methods.delete(key); cell = undefined; }
  if (!cell) {
    if (typeof object[key] !== "function") throw new Error("Patch target is not a method");
    const created: Cell = { original: object[key], descriptor: Object.getOwnPropertyDescriptor(object, key), layers: [], wrapper: function() {} };
    created.wrapper = function(this: any, ...args: any[]) {
      const layers = [...created.layers];
      const dispatch = (index: number, nextArgs: any[]): any => index < 0
        ? Reflect.apply(created.original, this, nextArgs)
        : layers[index].around(nextArgs, (...replacement) => dispatch(index - 1, replacement), this);
      return dispatch(layers.length - 1, args);
    };
    Object.defineProperty(object, key, { value: created.wrapper, writable: true, configurable: true });
    methods.set(key, created); cell = created;
  }
  const ownedCell = cell;
  const layer = { owner, around };
  ownedCell.layers.push(layer);
  let removed = false;
  return () => {
    if (removed) return; removed = true;
    const index = ownedCell.layers.indexOf(layer);
    if (index >= 0) ownedCell.layers.splice(index, 1);
    if (ownedCell.layers.length === 0) {
      if (object[key] === ownedCell.wrapper) {
        if (ownedCell.descriptor) Object.defineProperty(object, key, ownedCell.descriptor);
        else delete object[key];
      }
      if (methods?.get(key) === ownedCell) methods.delete(key);
    }
  };
}
export function before(owner: string, object: any, key: PropertyKey, callback: (args: any[], self: any) => any[] | void) {
  return instead(owner, object, key, (args, next, self) => next(...(callback(args, self) ?? args)));
}
export function after(owner: string, object: any, key: PropertyKey, callback: (result: any, args: any[], self: any) => any) {
  return instead(owner, object, key, (args, next, self) => {
    const result = next(...args);
    const apply = (value: any) => { const replacement = callback(value, args, self); return replacement === undefined ? value : replacement; };
    return result && typeof result.then === "function" ? result.then(apply) : apply(result);
  });
}
