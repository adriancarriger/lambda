import * as fs from 'fs';
import * as path from 'path';

import {
  clearReceiptsForPane,
  createSendReceipt,
  deleteSendReceipt,
  hasSendReceipt,
} from '../index';

const RECEIPT_DIR = '/tmp/lambda-wait-receipts';

describe('clearReceiptsForPane', () => {
  const testDir = path.join(RECEIPT_DIR);

  beforeEach(() => {
    // Ensure clean state
    if (fs.existsSync(testDir)) {
      for (const file of fs.readdirSync(testDir)) {
        if (file.endsWith('.receipt')) {
          fs.unlinkSync(path.join(testDir, file));
        }
      }
    } else {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test receipts
    if (fs.existsSync(testDir)) {
      for (const file of fs.readdirSync(testDir)) {
        if (file.endsWith('.receipt')) {
          fs.unlinkSync(path.join(testDir, file));
        }
      }
    }
  });

  it('should remove receipts matching the pane', () => {
    // Create receipts with known pane hash prefix
    // The pane hash for "lambda:dev" is deterministic
    const { createHash } = require('crypto');
    const paneHashVal = createHash('md5')
      .update('lambda:dev')
      .digest('hex')
      .slice(0, 8);

    const receipt1 = path.join(testDir, `${paneHashVal}_abc123.receipt`);
    const receipt2 = path.join(testDir, `${paneHashVal}_def456.receipt`);

    fs.writeFileSync(receipt1, Date.now().toString());
    fs.writeFileSync(receipt2, Date.now().toString());

    expect(fs.existsSync(receipt1)).toBe(true);
    expect(fs.existsSync(receipt2)).toBe(true);

    clearReceiptsForPane('lambda:dev');

    expect(fs.existsSync(receipt1)).toBe(false);
    expect(fs.existsSync(receipt2)).toBe(false);
  });

  it('should not remove receipts for other panes', () => {
    const { createHash } = require('crypto');
    const devHash = createHash('md5')
      .update('lambda:dev')
      .digest('hex')
      .slice(0, 8);
    const qaHash = createHash('md5')
      .update('lambda:qa')
      .digest('hex')
      .slice(0, 8);

    const devReceipt = path.join(testDir, `${devHash}_abc123.receipt`);
    const qaReceipt = path.join(testDir, `${qaHash}_def456.receipt`);

    fs.writeFileSync(devReceipt, Date.now().toString());
    fs.writeFileSync(qaReceipt, Date.now().toString());

    clearReceiptsForPane('lambda:dev');

    expect(fs.existsSync(devReceipt)).toBe(false);
    expect(fs.existsSync(qaReceipt)).toBe(true);

    // Clean up
    fs.unlinkSync(qaReceipt);
  });

  it('should handle missing receipt directory gracefully', () => {
    // Remove the directory temporarily
    const tempDir = '/tmp/lambda-wait-receipts-backup';

    if (fs.existsSync(testDir)) {
      fs.renameSync(testDir, tempDir);
    }

    // Should not throw
    expect(() => clearReceiptsForPane('lambda:dev')).not.toThrow();

    // Restore
    if (fs.existsSync(tempDir)) {
      fs.renameSync(tempDir, testDir);
    }
  });

  it('should not remove non-receipt files', () => {
    const { createHash } = require('crypto');
    const devHash = createHash('md5')
      .update('lambda:dev')
      .digest('hex')
      .slice(0, 8);

    const receiptFile = path.join(testDir, `${devHash}_abc.receipt`);
    const otherFile = path.join(testDir, `${devHash}_abc.txt`);

    fs.writeFileSync(receiptFile, Date.now().toString());
    fs.writeFileSync(otherFile, 'not a receipt');

    clearReceiptsForPane('lambda:dev');

    expect(fs.existsSync(receiptFile)).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(true);

    // Clean up
    fs.unlinkSync(otherFile);
  });

  it('should also clear send receipts for the pane', () => {
    createSendReceipt('lambda:dev');
    expect(hasSendReceipt('lambda:dev')).toBe(true);

    clearReceiptsForPane('lambda:dev');
    expect(hasSendReceipt('lambda:dev')).toBe(false);
  });
});

describe('send receipts', () => {
  const testDir = path.join(RECEIPT_DIR);

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      for (const file of fs.readdirSync(testDir)) {
        if (file.endsWith('.receipt')) {
          fs.unlinkSync(path.join(testDir, file));
        }
      }
    } else {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      for (const file of fs.readdirSync(testDir)) {
        if (file.endsWith('.receipt')) {
          fs.unlinkSync(path.join(testDir, file));
        }
      }
    }
  });

  it('should create and detect a send receipt', () => {
    expect(hasSendReceipt('lambda:scratchPad')).toBe(false);

    createSendReceipt('lambda:scratchPad');
    expect(hasSendReceipt('lambda:scratchPad')).toBe(true);
  });

  it('should delete a send receipt', () => {
    createSendReceipt('lambda:scratchPad');
    expect(hasSendReceipt('lambda:scratchPad')).toBe(true);

    deleteSendReceipt('lambda:scratchPad');
    expect(hasSendReceipt('lambda:scratchPad')).toBe(false);
  });

  it('should not affect other panes', () => {
    createSendReceipt('lambda:dev');
    expect(hasSendReceipt('lambda:dev')).toBe(true);
    expect(hasSendReceipt('lambda:qa')).toBe(false);
  });

  it('should handle deleting a non-existent send receipt gracefully', () => {
    expect(() => deleteSendReceipt('lambda:nonexistent')).not.toThrow();
  });
});
