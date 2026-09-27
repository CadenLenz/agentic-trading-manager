/** Explicit messages only: never return arbitrary broker/SDK error payloads. */
export function actionError(message:string):string|null {
  const known:Record<string,string>={
    'Configuration changed; review a fresh diff':'Someone changed the risk settings while you were editing. Reload the page and review your changes again before saving.',
    'Required acceptance evidence is missing or pre-production lock is active':'This checkpoint is not ready. Complete the unchecked requirements above. Real trading remains disabled in this release.',
    'Explicit sequential stage confirmation required':'Complete the current checkpoint before advancing to the next one.',
    'Read Only blocks execution':'Read-only mode cannot place trades. No order was sent.',
    'DO NOT ENABLE LIVE YET: pre-production execution lock':'Real trading is disabled in this release. You can test this trade in simulation.',
    'Proposal is not ready':'This trade still needs research and risk review. Open its details to see the remaining steps.',
    'Explicit approval for this version/preview required':'Review and approve the current trade preview before requesting execution. An older approval cannot be reused.',
    'Broker identity/catalog mapping not verified':'The account mapping no longer matches Robinhood. Review the protected mapping against the current connection catalog, then sync again. Trading stays blocked.',
    'Authenticate official MCP and install a reviewed schema mapping in ROBINHOOD_BINDING_FILE; no contract is guessed':'Robinhood account mapping is missing. Connect Robinhood, install the reviewed mapping in ROBINHOOD_BINDING_FILE on the Pi, and restart before syncing. Trading stays blocked.',
    'Connect Robinhood first':'Connect Robinhood in Setup & connections, then retry the account sync.',
    'Trading workflow busy':'Another trade action is still running. Wait for its result before trying again.',
  };
  return known[message]??null;
}
