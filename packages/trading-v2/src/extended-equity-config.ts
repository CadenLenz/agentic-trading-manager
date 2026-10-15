import type {AppDatabase} from '../../database/src/database.js';
import {RiskConfigurationService} from './configuration.js';
export function enableExtendedEquities(db:AppDatabase){
  if(db.getSetting('extended_equities_release_v1',false))return;
  const service=new RiskConfigurationService(db),current=service.current(),config=structuredClone(current.config);
  for(const sleeve of ['SAFE_LONG_TERM','AGGRESSIVE_STOCKS'] as const)config.strategies[sleeve]={...config.strategies[sleeve],extendedHoursAllowed:true,allowedMarketSessions:['REGULAR','EXTENDED']};
  service.apply(config,current.version,'OPERATOR_AUTHORIZED_DEPLOYMENT','Enable requested extended-hours whole-share equity limit orders, retaining all exposure and approval safeguards.','APPLY RISK CONFIGURATION');
  db.setSetting('extended_equities_release_v1',true);
}
