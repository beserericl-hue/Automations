import { describe, it, expect } from 'vitest';
import { DeleteAccountSchema } from '../schemas.js';

describe('S3-7: DeleteAccountSchema', () => {
  it('accepts confirmation = "DELETE"', () => {
    const result = DeleteAccountSchema.safeParse({ confirmation: 'DELETE' });
    expect(result.success).toBe(true);
  });

  it('rejects lowercase "delete"', () => {
    const result = DeleteAccountSchema.safeParse({ confirmation: 'delete' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = DeleteAccountSchema.safeParse({ confirmation: '' });
    expect(result.success).toBe(false);
  });

  it('rejects missing confirmation', () => {
    const result = DeleteAccountSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('S3-7: Account route module', () => {
  it('exports accountRouter', async () => {
    const mod = await import('../routes/account.js');
    expect(mod.accountRouter).toBeDefined();
  });
});
