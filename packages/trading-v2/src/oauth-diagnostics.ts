/** Deliberately excludes request/response bodies, headers and URL query strings. */
export type OAuthStage='DISCOVERY'|'REGISTRATION'|'AUTHORIZATION'|'CALLBACK'|'PKCE'|'TOKEN_EXCHANGE'|'TOKEN_REFRESH'|'CATALOG'|'ACCOUNT_MAPPING'|'ACCOUNT_SCOPE'|'TRANSPORT';
export interface OAuthDiagnostic {stage:OAuthStage;code:string;at:string;provider:'ROBINHOOD';callbackOrigin:string;state:string;httpStatus?:number}
export function oauthRequestStage(input:string|URL|Request,init?:RequestInit):OAuthStage {
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.pathname.includes('/.well-known/'))return 'DISCOVERY';
  if(url.pathname==='/oauth/trading/register')return 'REGISTRATION';
  if(url.pathname==='/oauth2/token/')return new URLSearchParams(typeof init?.body==='string'||init?.body instanceof URLSearchParams?init.body:undefined).get('grant_type')==='refresh_token'?'TOKEN_REFRESH':'TOKEN_EXCHANGE';
  return 'TRANSPORT';
}
export function diagnostic(stage:OAuthStage,code:string,callback:string,state:string,httpStatus?:number):OAuthDiagnostic {
  return {stage,code,at:new Date().toISOString(),provider:'ROBINHOOD',callbackOrigin:new URL(callback).origin,state,...(httpStatus===undefined?{}:{httpStatus})};
}
