import {afterEach,describe,expect,it,vi} from 'vitest';
import {openDatabase,type AppDatabase} from '../packages/database/src/database.js';
import {AutonomousSupervisor,DEFAULT_SUPERVISOR_CONFIG,type SupervisorCallbacks,type SupervisorSnapshot,type SupervisorTaskStatus} from '../packages/trading-v2/src/autonomous-supervisor.js';
const databases:AppDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();});
const start=new Date('2026-09-30T15:00:00.000Z');
function fixture(){
  const db=openDatabase(':memory:');databases.push(db);db.setSetting('global_pause',false);
  const snapshot:SupervisorSnapshot={mode:'AUTONOMOUS_LIVE',paused:false,stopped:false,reconciled:true,brokerHealthy:true,accountAsOf:start.toISOString(),market:{open:true,verified:true,date:'2026-09-30',closesAt:'2026-09-30T20:00:00Z',nextOpen:'2026-10-01T13:30:00Z'},sleeves:{SAFE_LONG_TERM:{enabled:true,autonomous:true,killed:false,positions:[],orders:[]},AGGRESSIVE_STOCKS:{enabled:true,autonomous:true,killed:false,positions:[],orders:[]},OPTIONS:{enabled:true,autonomous:true,killed:false,positions:[{id:'option',quantity:1,price:2,underlyingPrice:100,expiresAt:'2026-10-30T20:00:00Z',iv:.3,delta:.4,spreadPercent:2}],orders:[]}}};
  let now=start;let taskStatus:SupervisorTaskStatus='COMPLETED';
  const callbacks:SupervisorCallbacks={snapshot:vi.fn(()=>structuredClone(snapshot)),reconcile:vi.fn(async()=>{snapshot.accountAsOf=now.toISOString();}),workerAvailable:vi.fn(async()=>true),createReasoning:vi.fn(async r=>({id:r.id})),taskStatus:vi.fn(()=>taskStatus),report:vi.fn(),onFault:vi.fn()};
  const supervisor=new AutonomousSupervisor(db,callbacks);
  return {db,snapshot,callbacks,supervisor,tick:async(minutes=0)=>{now=new Date(start.getTime()+minutes*60000);await supervisor.tick(now);},setTaskStatus:(s:SupervisorTaskStatus)=>{taskStatus=s;}};
}
describe('deterministic autonomous supervisor',()=>{
  it('prioritizes options, manages holdings first and deduplicates unchanged state across ticks/restart',async()=>{
    const f=fixture();await f.tick();
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(1);
    expect(f.callbacks.createReasoning).toHaveBeenLastCalledWith(expect.objectContaining({sleeve:'OPTIONS',message:expect.stringContaining('existing positions and active orders before')}));
    await f.tick(.25);await f.tick(.5);await f.tick(.75);
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(3); // one initial review per independent sleeve
    await f.tick(3);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(3);
    const resumed=new AutonomousSupervisor(f.db,f.callbacks);await resumed.tick(new Date(start.getTime()+3.1*60000));
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(3);
    expect(resumed.status().sleeves.OPTIONS.lastContextHash).toBeTruthy();
  });
  it('runs only one reasoning job globally and blocks concurrent ticks',async()=>{
    const f=fixture();f.setTaskStatus('RUNNING');
    await Promise.all([f.tick(),f.tick()]);await f.tick(3);
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(1);
    expect(f.supervisor.status().sleeves.OPTIONS.status).toBe('REASONING');
  });
  it('polls active orders directly during STOP and a Codex outage without invoking reasoning',async()=>{
    const f=fixture();f.snapshot.stopped=true;f.db.setSetting('stopped',true);
    f.snapshot.sleeves.OPTIONS.orders=[{id:'order',status:'PARTIALLY_FILLED',filledQuantity:.5}];
    vi.mocked(f.callbacks.workerAvailable).mockResolvedValue(false);
    await f.tick();await f.tick(.1);await f.tick(.25);
    expect(f.callbacks.reconcile).toHaveBeenCalledTimes(2);
    expect(f.callbacks.createReasoning).not.toHaveBeenCalled();
    expect(f.callbacks.workerAvailable).not.toHaveBeenCalled();
    expect(f.supervisor.status().sleeves.OPTIONS.reason).toBe('GLOBAL STOP');
  });
  it('rejects stale/unverified/disabled/killed sleeves and obeys a STOP arriving during worker health',async()=>{
    const f=fixture();f.snapshot.sleeves.SAFE_LONG_TERM.killed=true;f.snapshot.sleeves.AGGRESSIVE_STOCKS.autonomous=false;
    vi.mocked(f.callbacks.workerAvailable).mockImplementation(async()=>{f.db.setSetting('stopped',true);return true;});
    await f.tick();expect(f.callbacks.createReasoning).not.toHaveBeenCalled();
    f.db.setSetting('stopped',false);f.snapshot.market.verified=false;await f.tick(.25);
    expect(f.supervisor.status().sleeves.OPTIONS.reason).toBe('Verified market calendar required');
    expect(f.supervisor.status().sleeves.SAFE_LONG_TERM.reason).toBe('Sleeve kill switch');
    expect(f.supervisor.status().sleeves.AGGRESSIVE_STOCKS.status).toBe('PAUSED');
  });
  it('does not call trading reasoning while closed or in manual/read-only mode',async()=>{
    const f=fixture();f.snapshot.market.open=false;await f.tick();
    expect(f.supervisor.status().sleeves.OPTIONS.nextAnalysisAt).toBe(f.snapshot.market.nextOpen);
    f.snapshot.market.open=true;f.snapshot.mode='LIVE';await f.tick(.25);
    f.snapshot.mode='READ_ONLY';await f.tick(.5);
    expect(f.callbacks.createReasoning).not.toHaveBeenCalled();
  });
  it('reacts to material option changes only after cooldown and suppresses repeated unchanged events',async()=>{
    const f=fixture();f.snapshot.sleeves.SAFE_LONG_TERM.enabled=false;f.snapshot.sleeves.AGGRESSIVE_STOCKS.enabled=false;
    await f.tick();f.snapshot.sleeves.OPTIONS.positions[0]!.price=2.5;await f.tick(1);
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(1);
    await f.tick(3);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(2);
    expect(f.callbacks.createReasoning).toHaveBeenLastCalledWith(expect.objectContaining({reason:'Material position price movement'}));
    await f.tick(6);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(2);
    f.snapshot.sleeves.OPTIONS.orders=[{id:'order',status:'PARTIALLY_FILLED',filledQuantity:.5}];await f.tick(7);
    expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(3);
    expect(f.callbacks.report).toHaveBeenCalledTimes(1);
    await f.tick(8);expect(f.callbacks.report).toHaveBeenCalledTimes(1);
  });
  it('adapts reasoning to approaching expiry without a tight loop',async()=>{
    const f=fixture();f.snapshot.sleeves.SAFE_LONG_TERM.enabled=false;f.snapshot.sleeves.AGGRESSIVE_STOCKS.enabled=false;
    f.snapshot.sleeves.OPTIONS.positions[0]!.expiresAt='2026-10-01T20:00:00Z';
    await f.tick();await f.tick(3);await f.tick(9);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(1);
    await f.tick(10);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(2);
    expect(f.callbacks.createReasoning).toHaveBeenLastCalledWith(expect.objectContaining({reason:'Approaching option expiry review'}));
  });
  it('blocks analysis on unavailable Codex, but retains deterministic monitoring and persisted configuration',async()=>{
    const f=fixture();vi.mocked(f.callbacks.workerAvailable).mockResolvedValue(false);
    f.supervisor.configure('OPTIONS',{...DEFAULT_SUPERVISOR_CONFIG.OPTIONS,reviewMinutes:30},'operator');
    await f.tick();await f.tick(1);
    expect(f.callbacks.createReasoning).not.toHaveBeenCalled();expect(f.callbacks.reconcile).toHaveBeenCalledTimes(2);
    expect(f.supervisor.status().sleeves.OPTIONS.reason).toContain('Codex unavailable');
    expect(new AutonomousSupervisor(f.db,f.callbacks).config().OPTIONS.reviewMinutes).toBe(30);
    expect(()=>f.supervisor.configure('OPTIONS',{...DEFAULT_SUPERVISOR_CONFIG.OPTIONS,cooldownMinutes:0},'operator')).toThrow();
  });
  it('fails closed on reconciliation errors and never retries an ambiguous enqueue',async()=>{
    const f=fixture();vi.mocked(f.callbacks.createReasoning).mockRejectedValue(new Error('transport timeout'));
    await f.tick();const claimed=f.supervisor.state().sleeves.OPTIONS.activeTaskId;
    expect(claimed).toBeTruthy();expect(f.supervisor.state().sleeves.OPTIONS.lastTaskStatus).toBe('UNKNOWN');
    f.setTaskStatus('RUNNING');await f.tick(30);expect(f.callbacks.createReasoning).toHaveBeenCalledTimes(1);
    vi.mocked(f.callbacks.reconcile).mockRejectedValue(new Error('broker disconnected'));await f.tick(31);
    expect(f.db.getSetting('global_pause')).toBe(true);expect(f.callbacks.onFault).toHaveBeenCalledTimes(1);
    expect(f.supervisor.state().sleeves.OPTIONS.status).toBe('BLOCKED');
  });
  it('generates daily and weekly reports once without consuming Codex',async()=>{
    const f=fixture();f.snapshot.market.open=false;f.snapshot.market.lastSessionOfWeek=true;
    await f.tick(306);await f.tick(307);
    expect(f.callbacks.report).toHaveBeenCalledTimes(7);
    expect(f.callbacks.createReasoning).not.toHaveBeenCalled();
    const resumed=new AutonomousSupervisor(f.db,f.callbacks);await resumed.tick(new Date(start.getTime()+308*60000));
    expect(f.callbacks.report).toHaveBeenCalledTimes(7);
  });
});
