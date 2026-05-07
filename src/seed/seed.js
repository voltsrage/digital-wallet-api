import 'dotenv/config';
import { knex } from '../db/knex.js';
import Decimal from 'decimal.js';

async function seed() {
  // Clear in reverse dependency order
  await knex('outbox_events').del();
  await knex('ledger_entries').del();
  await knex('transfers').del();
  await knex('accounts').del();
  await knex('users').del();

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
  await knex.destroy();
}

seed().catch(err => { console.error(err); process.exit(1); });