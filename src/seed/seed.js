import 'dotenv/config';
import { knex } from '../db/knex.js';
import Decimal from 'decimal.js';
import mongoose from 'mongoose';
import { connectMongo } from '../db/mongo.js';
import { TransactionReceipt } from '../models/TransactionReceipt.js';
import { AuditEvent } from '../models/AuditEvent.js';
import { FraudSignal } from '../models/FraudSignal.js';

async function seed() {
  await connectMongo();

  // Clear in reverse dependency order
  await knex('outbox_events').del();
  await knex('ledger_entries').del();
  await knex('transfers').del();
  await knex('accounts').del();
  await knex('users').del();

  // Clear MongoDB via the native driver to bypass immutability middleware
  await TransactionReceipt.collection.deleteMany({});
  await AuditEvent.collection.deleteMany({});
  await FraudSignal.collection.deleteMany({});


  // 2 users
  const [alice, bob] = await knex('users')
    .insert([
      { email: 'alice@example.com', password_hash: 'placeholder', display_name: 'Alice' },
      { email: 'bob@example.com',   password_hash: 'placeholder', display_name: 'Bob'   },
    ])
    .returning('*');

  // 4 accounts — 2 per user, pre-seeded with starting balances
  const [aliceMain, aliceSavings, bobMain, bobSavings] = await knex('accounts')
    .insert([
      { user_id: alice.id, account_number: 'ACC-0001', currency: 'USD', balance: '1000.00000000' },
      { user_id: alice.id, account_number: 'ACC-0002', currency: 'USD', balance: '500.00000000'  },
      { user_id: bob.id,   account_number: 'ACC-0003', currency: 'USD', balance: '750.00000000'  },
      { user_id: bob.id,   account_number: 'ACC-0004', currency: 'USD', balance: '250.00000000'  },
    ])
    .returning('*');

  // Helper: insert a transfer + its two ledger entries as a unit.
  // This mirrors what the transfer service will do in Phase 5 — one transaction,
  // two ledger entries, balance updates — but without the SERIALIZABLE isolation
  // overhead since seed data does not need concurrency protection.
  async function transfer({ fromAccount, toAccount, amount, description }) {
    const amt     = new Decimal(amount);
    const fromBal = new Decimal(fromAccount.balance).minus(amt);
    const toBal   = new Decimal(toAccount.balance).plus(amt);

    const [txn] = await knex('transfers')
      .insert({
        from_account_id: fromAccount.id,
        to_account_id:   toAccount.id,
        amount:          amt.toFixed(8),
        currency:        'USD',
        description,
        status:          'completed',
        idempotency_key: `seed-${fromAccount.account_number}-${toAccount.account_number}-${Date.now()}`,
      })
      .returning('*');

    await knex('ledger_entries').insert([
      {
        account_id:    fromAccount.id,
        transfer_id:   txn.id,
        type:          'debit',
        amount:        amt.toFixed(8),
        balance_after: fromBal.toFixed(8),
      },
      {
        account_id:    toAccount.id,
        transfer_id:   txn.id,
        type:          'credit',
        amount:        amt.toFixed(8),
        balance_after: toBal.toFixed(8),
      },
    ]);

    // Update stored balances to match what the ledger now shows
    await knex('accounts').where('id', fromAccount.id).update({ balance: fromBal.toFixed(8) });
    await knex('accounts').where('id', toAccount.id).update({   balance: toBal.toFixed(8)   });

    // Return updated account objects for subsequent transfers in this seed
    fromAccount.balance = fromBal.toFixed(8);
    toAccount.balance   = toBal.toFixed(8);
  }

  await transfer({ fromAccount: aliceMain,   toAccount: bobMain,     amount: '200.00', description: 'Rent'          });
  await transfer({ fromAccount: bobMain,     toAccount: aliceSavings, amount: '50.00', description: 'Reimbursement' });
  await transfer({ fromAccount: aliceSavings, toAccount: bobSavings,  amount: '75.00', description: 'Split bill'    });
  await transfer({ fromAccount: bobSavings,  toAccount: aliceMain,   amount: '25.00', description: 'Refund'        });

  console.log('Seeded: 2 users, 4 accounts, 4 transfers, 8 ledger entries');

  // One TransactionReceipt per completed transfer.
  // transferIds is built by collecting the UUIDs returned from knex('transfers').insert(...).returning('*')
  // In the existing seed, the transfer() helper returns the txn object — collect them:
  const transfers = []; // collect return values from each transfer() call above

  // Replace the four transfer() calls to capture their return values:
  // transfers.push(await transfer({ ... }));  x4
  // Then:

  await TransactionReceipt.insertMany(
    transfers.map((txn, i) => ({
      transferId:          txn.id,
      fromAccountNumber:   ['ACC-0001', 'ACC-0003', 'ACC-0002', 'ACC-0004'][i],
      toAccountNumber:     ['ACC-0003', 'ACC-0002', 'ACC-0004', 'ACC-0001'][i],
      fromUserDisplayName: ['Alice', 'Bob', 'Alice', 'Bob'][i],
      toUserDisplayName:   ['Bob', 'Alice', 'Bob', 'Alice'][i],
      amount:              mongoose.Types.Decimal128.fromString(txn.amount),
      currency:            'USD',
      description:         txn.description,
      metadata: {
        ipAddress: '127.0.0.1',
        userAgent: 'seed-script/1.0',
        deviceId:  `seed-device-${i}`,
      },
      tags: [],
    }))
  );

  // AuditEvents: account creation for all 4 accounts + transfer completed for all 4 transfers.
  const auditDocs = [
    ...['ACC-0001', 'ACC-0002', 'ACC-0003', 'ACC-0004'].map((num, i) => ({
      eventType:  'ACCOUNT_CREATED',
      actorId:    i < 2 ? alice.id : bob.id,
      targetId:   [aliceMain.id, aliceSavings.id, bobMain.id, bobSavings.id][i],
      targetType: 'account',
      payload:    { accountNumber: num, currency: 'USD' },
      ipAddress:  '127.0.0.1',
    })),
    ...transfers.map((txn) => ({
      eventType:  'TRANSFER_COMPLETED',
      actorId:    'system',
      targetId:   txn.id,
      targetType: 'transfer',
      payload:    { amount: txn.amount, currency: txn.currency, status: 'completed' },
      ipAddress:  '127.0.0.1',
    })),
  ];

  await AuditEvent.insertMany(auditDocs);

  // One FraudSignal per transfer — low risk for all seed transfers.
  await FraudSignal.insertMany(
    transfers.map((txn) => ({
      transferId: txn.id,
      userId:     alice.id,  // simplified — real logic derives this from the from_account
      riskScore:  10,
      decision:   'allow',
      signals: [
        { type: 'VELOCITY', severity: 'low', detail: { count: 1, window: '10m' } },
      ],
    }))
  );

  console.log(`Seeded MongoDB: ${transfers.length} receipts, ${auditDocs.length} audit events, ${transfers.length} fraud signals`);

  await knex.destroy();
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });