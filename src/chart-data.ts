export type Point={at:string;value:number;price?:number};
export function periodHoldingChange(points:Point[],quantity:number):number|null {
  const observed=chartPoints(points).filter(p=>Number.isFinite(p.price));
  return observed.length<2?null:quantity*(observed.at(-1)!.price!-observed[0]!.price!);
}
export function chartPoints(points:Point[]) {
  return points.filter(p=>Number.isFinite(p.value)&&Number.isFinite(Date.parse(p.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
}
