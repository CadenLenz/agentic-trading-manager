import type {AppDatabase} from '../../database/src/database.js';
export function commonStocks(text:string){
  const lines=text.trim().split(/\r?\n/),headers=lines.shift()!.split('|');
  if(!headers.includes('ETF')||!headers.includes('Test Issue')||!headers.includes('Security Name')||!lines.some(l=>l.startsWith('File Creation Time:')))throw new Error('Official symbol directory format unverified');
  return lines.flatMap(line=>{const fields=line.split('|'),row=Object.fromEntries(headers.map((h,i)=>[h,fields[i]]));
    const symbol=row.Symbol??row['NASDAQ Symbol'];
    return symbol&&row.ETF==='N'&&row['Test Issue']==='N'&&/common (?:stock|shares)|class [a-z] (?:common|capital)/i.test(row['Security Name']??'')&&!/warrant|preferred|units|debenture|note|leveraged|inverse/i.test(row['Security Name']??'')?[symbol]:[];
  });
}
export async function listedCommonStock(db:AppDatabase,symbol:string){
  let cache=db.getSetting<{at:number;symbols:string[]}|null>('official_common_stock_directory',null);
  if(!cache||Date.now()-cache.at>86400000){
    const symbols:string[]=[];
    for(const file of ['nasdaqlisted','otherlisted']){const response=await fetch('https://www.nasdaqtrader.com/dynamic/symdir/'+file+'.txt',{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Official listing directory unavailable');symbols.push(...commonStocks(await response.text()));}
    cache={at:Date.now(),symbols};db.setSetting('official_common_stock_directory',cache);
  }
  return cache.symbols.includes(symbol);
}
