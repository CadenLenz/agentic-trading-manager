/** Pacific calendar boundaries, including DST; not rolling 24h/7d windows. */
export function pacificPeriodStart(period:'DAY'|'WEEK',date=new Date()){
  const key=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
  const local=new Date(key+'T00:00:00.000Z');if(period==='WEEK')local.setUTCDate(local.getUTCDate()-((local.getUTCDay()+6)%7));
  const midnight=local.getTime();let candidate=midnight;
  for(let i=0;i<3;i++){const offset=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'longOffset'}).formatToParts(new Date(candidate)).find(p=>p.type==='timeZoneName')!.value;const m=/GMT([+-])(\d{2}):(\d{2})/.exec(offset);const minutes=m?(m[1]==='-'?-1:1)*(Number(m[2])*60+Number(m[3])):0;candidate=midnight-minutes*60000;}
  return new Date(candidate).toISOString();
}
