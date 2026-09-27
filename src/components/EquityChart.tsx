import {useId,useState} from 'react';
import {chartPoints,type Point} from '../chart-data';
export type {Point} from '../chart-data';
export function EquityChart({points,label,compact=false}:{points:Point[];label:string;compact?:boolean}) {
  const id=useId().replaceAll(':',''),[selected,setSelected]=useState<number|null>(null),data=chartPoints(points);
  if(data.length<2)return <div className={'chart-empty '+(compact?'compact':'')}><span>{data.length?'History is building':'No history yet'}</span>{!compact&&<small>Recorded values will appear here after two observations. Try another time range.</small>}</div>;
  const values=data.map(p=>p.value),low=Math.min(...values),high=Math.max(...values),padding=Math.max((high-low)*.12,Math.abs(high)*.001,.01),range=high-low+2*padding;
  const start=Date.parse(data[0]!.at),duration=Date.parse(data.at(-1)!.at)-start;
  const x=(i:number)=>24+(duration?(Date.parse(data[i]!.at)-start)/duration:i/(data.length-1))*752;
  const y=(v:number)=>156-(v-low+padding)/range*132;
  const path=data.map((p,i)=>(i?'L':'M')+x(i)+','+y(p.value)).join(' '),gain=values.at(-1)!-values[0]!;
  const color=gain>0?'var(--green)':gain<0?'var(--red)':'var(--muted)',index=Math.min(selected??data.length-1,data.length-1),point=data[index]!;
  const money=(v:number)=>v.toLocaleString('en-US',{style:'currency',currency:'USD'});
  return <div className={'equity-chart '+(compact?'compact':'')}>
    {!compact&&<div className="chart-readout" aria-live="polite"><strong>{money(point.value)}</strong><span>{new Date(point.at).toLocaleString()} · recorded value</span></div>}
    <svg viewBox="0 0 800 180" role="img" aria-label={label+': '+money(values[0]!)+' to '+money(values.at(-1)!)} onPointerMove={e=>{if(compact)return;const bounds=e.currentTarget.getBoundingClientRect(),target=(e.clientX-bounds.left)/bounds.width*800;let nearest=0;data.forEach((_,i)=>{if(Math.abs(x(i)-target)<Math.abs(x(nearest)-target))nearest=i;});setSelected(nearest);}} onPointerLeave={()=>setSelected(null)}>
      <title>{label}. {gain>=0?'Increased':'Decreased'} in value by {money(Math.abs(gain))}. Value change includes deposits, withdrawals, and position sizing.</title>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".16"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
      <path d={path+` L ${x(data.length-1)},174 L 24,174 Z`} fill={`url(#${id})`}/><path d={path} stroke={color} fill="none" strokeWidth={compact?3:2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      {selected!==null&&!compact&&<><line x1={x(index)} x2={x(index)} y1="12" y2="174" stroke="var(--line-bright)" strokeDasharray="4 4"/><circle cx={x(index)} cy={y(point.value)} r="5" fill={color}/></>}
    </svg>
    {!compact&&<><input className="chart-scrubber" aria-label={'Explore '+label} type="range" min="0" max={data.length-1} value={index} onChange={e=>setSelected(Number(e.target.value))}/><div className="chart-dates"><span>{new Date(data[0]!.at).toLocaleDateString()}</span><span>{new Date(data.at(-1)!.at).toLocaleDateString()}</span></div></>}
  </div>;
}
