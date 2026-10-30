// The seam for the playtest events of PRODUCT.md §4 on the browser's side, filled by `add-analytics`. In this change
// it records nothing and sends nothing.
export type TrackProps = Record<string, string | number | boolean>;

export function track(_name: string, _props?: TrackProps): void {}
