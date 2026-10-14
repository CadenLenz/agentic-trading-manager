import {it,expect,vi} from 'vitest';
import {AgenticManager} from '../packages/core/src/agentic-manager.js';
import {refreshOptionMonitoring} from '../packages/trading-v2/src/autonomous-runtime.js';
it('starts with no held contracts or prior option-monitor setting outside market hours',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T21:00:00Z'));
  const m=new AgenticManager({databasePath:':memory:',workingDirectory:process.cwd(),sessionSecret:'monitor-test-secret-with-more-than-thirty-two-characters',startBackgroundServices:false});
  try{await m.start();await m.autonomousSupervisor.tick();expect(m.autonomousSupervisor.state().lastError).toBeNull();}
  finally{await m.shutdown();vi.useRealTimers();}
});
it('polls an existing contract without mutations, records market telemetry, and isolates unavailable quotes',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
  const m=new AgenticManager({databasePath:':memory:',workingDirectory:process.cwd(),sessionSecret:'monitor-test-secret-with-more-than-thirty-two-characters',startBackgroundServices:false});
  try{await m.start();const option={optionId:'held-call',underlying:'KO',type:'CALL' as const,strike:90,expiration:'2026-11-20',multiplier:100 as const};
    m.database.raw.prepare('INSERT INTO option_positions VALUES(?,?,?,?,?,?,?,?,?)').run(option.optionId,'OPTIONS',JSON.stringify(option),1,2,2,0,0,new Date().toISOString());
    const quote=vi.spyOn(m.liveBroker,'quote').mockResolvedValue({symbol:'KO',option,price:2.1,bid:2,ask:2.2,volume:100,asOf:new Date().toISOString(),tradingEligible:true,underlyingPrice:91,iv:.4,delta:.6,provenance:'MOCK'});
    const place=vi.spyOn(m.liveBroker,'place');await refreshOptionMonitoring(m);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({positionEffect:'CLOSE',option:expect.objectContaining({optionId:'held-call'})}));
    expect(m.database.getSetting('option_monitor:held-call')).toMatchObject({price:2.1,iv:.4,delta:.6,underlyingPrice:91});
    expect(m.analytics.optionDetail('held-call')).toMatchObject({iv:.4,delta:.6});expect(place).not.toHaveBeenCalled();
    quote.mockRejectedValue(new Error('unavailable'));await refreshOptionMonitoring(m);expect(m.database.getSetting<string>('option_monitor_fault')).toContain('OPTIONS decisions paused');
    expect(m.database.getSetting('global_pause')).toBe(false);expect(m.database.raw.prepare('SELECT COUNT(*) AS n FROM executions_v2').get()).toEqual({n:0});
  }finally{await m.shutdown();vi.useRealTimers();}
});
