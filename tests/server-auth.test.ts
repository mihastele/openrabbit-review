import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSession,
  isAuthenticated,
  tokensEqual,
} from '../src/server/auth.js';

function requestWithCookie(cookie?: string) {
  return { headers: { cookie } } as any;
}

describe('Dashboard session authentication', () => {
  it('accepts only a valid unexpired session', () => {
    const now = 1_800_000_000_000;
    const secret = 'test-admin-token';
    const cookie = `openrabbit_session=${createSession(secret, now)}`;

    assert.equal(isAuthenticated(requestWithCookie(cookie), secret, now + 1000), true);
    assert.equal(
      isAuthenticated(requestWithCookie(cookie), secret, now + 13 * 60 * 60 * 1000),
      false
    );
    assert.equal(isAuthenticated(requestWithCookie(cookie), 'wrong-token', now), false);
  });

  it('rejects malformed, unsigned, and missing cookies', () => {
    const now = 1_800_000_000_000;
    assert.equal(isAuthenticated(requestWithCookie(), 'secret', now), false);
    assert.equal(
      isAuthenticated(requestWithCookie('openrabbit_session=garbage'), 'secret', now),
      false
    );
    assert.equal(
      isAuthenticated(
        requestWithCookie('openrabbit_session=9999999999.invalid'),
        'secret',
        now
      ),
      false
    );
  });

  it('uses constant-time-safe token comparisons for equal-length values', () => {
    assert.equal(tokensEqual('abc', 'abc'), true);
    assert.equal(tokensEqual('abc', 'abd'), false);
    assert.equal(tokensEqual('abc', 'abcd'), false);
  });

  it('allows anonymous development access only', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      assert.equal(isAuthenticated(requestWithCookie(), undefined), true);
      process.env.NODE_ENV = 'production';
      assert.equal(isAuthenticated(requestWithCookie(), undefined), false);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
