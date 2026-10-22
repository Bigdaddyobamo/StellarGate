import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSep7Uri } from '../format.js';

test('buildSep7Uri supports native and issued assets', () => {
  assert.equal(
    buildSep7Uri({ destination_address: 'GDESTINATION', amount: '10.25', asset: 'XLM', memo: 'order-42' }),
    'web+stellar:pay?destination=GDESTINATION&amount=10.25&memo=order-42&memo_type=text'
  );

  assert.equal(
    buildSep7Uri({ destination_address: 'GDESTINATION', amount: '10.25', asset: 'USDC', asset_issuer: 'GISSUER', memo: '42', memo_type: 'id' }),
    'web+stellar:pay?destination=GDESTINATION&amount=10.25&asset_code=USDC&asset_issuer=GISSUER&memo=42&memo_type=id'
  );

  assert.equal(
    buildSep7Uri({ destination: 'GDESTINATION', amount: '10.50', assetCode: 'EURT', assetIssuer: 'GISSUER', memo: '=cmd|/C calc', memoType: 'text' }),
    'web+stellar:pay?destination=GDESTINATION&amount=10.50&asset_code=EURT&asset_issuer=GISSUER&memo=%3Dcmd%7C%2FC+calc&memo_type=text'
  );
});
