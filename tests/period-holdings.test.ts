import {expect,it} from 'vitest';
import {periodHoldingChange} from '../src/chart-data.js';
import {openDatabase} from '../packages/database/src/database.js';
import {VirtualPortfolioLedger} from '../packages/ledger/src/virtual-ledger.js';
import {StrategyAllocationManager} from '../packages/trading-v2/src/capital.js';
import {PortfolioAnalytics} from '../packages/trading-v2/src/analytics.js';
it('uses the selected period price change and current shares, excluding sizing changes and lifetime basis',()=>{
  const points=[{at:'2026-10-01T00:00:00Z',value:100,price:100},{at:'2026-10-02T00:00:00Z',value:220,price:110}];
  expect(periodHoldingChange(points,2)).toBe(20);
  expect(periodHoldingChange(points.slice(1),2)).toBeNull();
  expect(periodHoldingChange([{...points[0]!,price:110},{...points[1]!,price:100}],2)).toBe(-20);
});
it('retains recorded price history across production mode changes and excludes simulated prices',()=>{
  const db=openDatabase(':memory:'),ledger=new VirtualPortfolioLedger(db),analytics=new PortfolioAnalytics(db,ledger,new StrategyAllocationManager(db,ledger));
  try{db.setSetting('operating_mode','AUTONOMOUS_LIVE');db.setSetting('broker_account_v2',{accountId:'history-fixture'});
    for(const [index,mode,price] of [[0,'READ_ONLY',100],[1,'AUTONOMOUS_LIVE',110],[2,'SIMULATION',999]] as const){const at=new Date(Date.now()-(3-index)*60000).toISOString(),id='history-'+index;
      db.raw.prepare('INSERT INTO portfolio_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(id,'history-fixture',mode,price,0,0,0,'TEST',at);
      db.raw.prepare('INSERT INTO position_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run('p-'+index,id,'SAFE_LONG_TERM','KO',1,price,price,0,at);
    }
    const points=analytics.series('1D','SAFE_LONG_TERM','KO').points;expect(points.map(p=>p.price)).toEqual([100,110]);expect(periodHoldingChange(points,2)).toBe(20);
  }finally{db.close();}
});
