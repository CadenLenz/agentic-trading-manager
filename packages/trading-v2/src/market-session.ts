import type {AppDatabase} from '../../database/src/database.js';
import {zonedDate} from './scheduling.js';
export function marketClock(db:AppDatabase,at=new Date()){
  const row=db.raw.prepare('SELECT opens_at,closes_at,verified_at FROM market_sessions WHERE date=?').get(zonedDate(at)) as {opens_at:string;closes_at:string;verified_at:string}|undefined;
  const now=at.getTime(),open=Date.parse(row?.opens_at??''),close=Date.parse(row?.closes_at??''),age=now-Date.parse(row?.verified_at??'');
  const verified=!!row&&age>=-5000&&age<7*86400000;
  // Normal sessions: 07:00–20:00 ET. Early-close afternoons require a reviewed
  // broker holiday schedule; retain only their verified regular session.
  const extendedClose=close-open===6.5*3600000?close+4*3600000:close;
  const next=db.raw.prepare('SELECT opens_at FROM market_sessions WHERE opens_at>? ORDER BY opens_at LIMIT 2').all(at.toISOString()) as Array<{opens_at:string}>;
  return {verified,regularOpen:verified&&now>=open&&now<close,equityOpen:verified&&now>=open-2.5*3600000&&now<extendedClose,
    nextRegularOpen:next[0]?.opens_at??null,nextEquityOpen:next.map(r=>new Date(Date.parse(r.opens_at)-2.5*3600000).toISOString()).find(value=>Date.parse(value)>now)??null};
}
export function sessionAllows(db:AppDatabase,hours:'REGULAR'|'EXTENDED',option:boolean,at=new Date()){
  const clock=marketClock(db,at);return hours==='REGULAR'?clock.regularOpen:!option&&clock.equityOpen;
}
