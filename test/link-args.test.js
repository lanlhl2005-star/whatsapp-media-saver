import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkArgs } from '../src/link-args.js';

describe('parseLinkArgs', () => {
  it('parses --phone and strips non-digits', () => {
    const prev = process.env.WMS_PHONE;
    delete process.env.WMS_PHONE;
    delete process.env.WHATSAPP_PHONE;
    try {
      const { phone } = parseLinkArgs(['--phone', '+852 9123-4567']);
      assert.equal(phone, '85291234567');
    } finally {
      if (prev === undefined) delete process.env.WMS_PHONE;
      else process.env.WMS_PHONE = prev;
    }
  });

  it('parses --timeout-ms', () => {
    const { timeoutMs } = parseLinkArgs(['--timeout-ms', '600000']);
    assert.equal(timeoutMs, 600000);
  });
});
