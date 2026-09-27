export type Point={at:string;value:number};
export function chartPoints(points:Point[]) {
  return points.filter(p=>Number.isFinite(p.value)&&Number.isFinite(Date.parse(p.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
}
