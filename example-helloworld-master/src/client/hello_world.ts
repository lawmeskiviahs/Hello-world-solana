/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import fs from 'mz/fs';
import path from 'path';
import * as borsh from 'borsh';

import {getPayer, getRpcUrl, createKeypairFromFile} from './utils';
import * as BufferLayout from '@solana/buffer-layout';
import { Buffer } from 'buffer';

/**
 * Connection to the network
 */
let connection: Connection;

/**
 * Keypair associated to the fees' payer
 */
let payer: Keypair;

/**
 * Hello world's program id
 */
let programId: PublicKey;

/**
 * The public key of the account we are saying hello to
 */
let greetedPubkey: PublicKey;

/**
 * The public key of the account we are creating
 */
 let customPubkey: PublicKey;

/**
 * Path to program files
 */
const PROGRAM_PATH = path.resolve(__dirname, '../../dist/program');

/**
 * Path to program shared object file which should be deployed on chain.
 * This file is created when running either:
 *   - `npm run build:program-c`
 *   - `npm run build:program-rust`
 */
const PROGRAM_SO_PATH = path.join(PROGRAM_PATH, 'helloworld.so');

/**
 * Path to the keypair of the deployed program.
 * This file is created when running `solana program deploy dist/program/helloworld.so`
 */
const PROGRAM_KEYPAIR_PATH = path.join(PROGRAM_PATH, 'helloworld-keypair.json');

/**
 * The state of a greeting account managed by the hello world program
 */
class GreetingAccount {
  inputA = 0; // initialization of variable
  inputB = 0; // initialization of variable
  sum = 0; // initialization of variable
  constructor(fields: {inputA: number, inputB: number, sum: number} | undefined = undefined) {
    if (fields) {
      this.inputA = fields.inputA;
      this.inputB = fields.inputB;
      this.sum = fields.sum;
    }
  }
}

/**
 * Creating a new class
 */
class CustomAccount{
    customdata1 = 0; // Initialising data
    customdata2 = 0; // Initailising data

    constructor(fields: {customdata1: number, customdata2: number} | undefined = undefined) {
        if (fields) {
          this.customdata1 = fields.customdata1;
          this.customdata2 = fields.customdata2;
        }
    }
}

/**
 * Borsh schema definition for greeting account
 */
const GreetingSchema = new Map([
  [GreetingAccount, {kind: 'struct', fields: [['inputA', 'u32'], ['inputB', 'u32'],['sum', 'u32'] ]}],
]);

/**
 * Borsh schema definition for custom account
 */
const CustomAccountSchema = new Map([
  [CustomAccount, {kind: 'struct', fields: [['customdata1', 'u32'], ['customdata2', 'u32'] ]}],
]);

/**
 * The expected size of greeting account.
 */
const GREETING_SIZE = borsh.serialize(
  GreetingSchema,
  new GreetingAccount(),
).length;

/**
 * The expected size of custom account.
 */
const CUSTOM_ACCOUNT_SIZE = borsh.serialize(
  CustomAccountSchema,
  new CustomAccount(),
).length;

/**
 * Establish a connection to the cluster
 */
export async function establishConnection(): Promise<void> {
  const rpcUrl = await getRpcUrl();
  connection = new Connection(rpcUrl, 'confirmed');
  const version = await connection.getVersion();
  console.log('Connection to cluster established:', rpcUrl, version);
}

/**
 * Establish an account to pay for everything
 */
export async function establishPayer(): Promise<void> {
  let fees = 0;
  if (!payer) {
    const {feeCalculator} = await connection.getRecentBlockhash();

    // Calculate the cost to fund the greeter account
    fees += await connection.getMinimumBalanceForRentExemption(GREETING_SIZE);

    // Calculate the cost of sending transactions
    fees += feeCalculator.lamportsPerSignature * 100; // wag

    payer = await getPayer();
  }

  let lamports = await connection.getBalance(payer.publicKey);
  if (lamports < fees) {
    // If current balance is not enough to pay for fees, request an airdrop
    const sig = await connection.requestAirdrop(
      payer.publicKey,
      fees - lamports,
    );
    await connection.confirmTransaction(sig);
    lamports = await connection.getBalance(payer.publicKey);
  }

  console.log(
    'Using account',
    payer.publicKey.toBase58(),
    'containing',
    lamports / LAMPORTS_PER_SOL,
    'SOL to pay for fees',
  );
}

/**
 * Check if the hello world BPF program has been deployed
 */
export async function checkProgram(): Promise<void> {
  // Read program id from keypair file
  try {
    const programKeypair = await createKeypairFromFile(PROGRAM_KEYPAIR_PATH);
    programId = programKeypair.publicKey;
  } catch (err) {
    const errMsg = (err as Error).message;
    throw new Error(
      `Failed to read program keypair at '${PROGRAM_KEYPAIR_PATH}' due to error: ${errMsg}. Program may need to be deployed with \`solana program deploy dist/program/helloworld.so\``,
    );
  }

  // Check if the program has been deployed
  const programInfo = await connection.getAccountInfo(programId);
  if (programInfo === null) {
    if (fs.existsSync(PROGRAM_SO_PATH)) {
      throw new Error(
        'Program needs to be deployed with `solana program deploy dist/program/helloworld.so`',
      );
    } else {
      throw new Error('Program needs to be built and deployed');
    }
  } else if (!programInfo.executable) {
    throw new Error(`Program is not executable`);
  }
  console.log(`Using program ${programId.toBase58()}`);

  // Derive the address (public key) of a greeting account from the program so that it's easy to find later.
  const GREETING_SEED = 'hello';
  greetedPubkey = await PublicKey.createWithSeed(
    payer.publicKey,
    GREETING_SEED,
    programId,
  );

  // Derive the address (public key) of a custom account from the program so that it's easy to find later.
  const CUSTOM_ACCOUNT_SEED = "Testing Account iterator"
  customPubkey = await PublicKey.createWithSeed(
      payer.publicKey,
      CUSTOM_ACCOUNT_SEED,
      programId,
    );

  // Check if the greeting account has already been created
  const greetedAccount = await connection.getAccountInfo(greetedPubkey);
  if (greetedAccount === null) {
    console.log(
      'Creating account',
      greetedPubkey.toBase58(),
      'to say hello to',
    );
    const lamports = await connection.getMinimumBalanceForRentExemption(
      GREETING_SIZE,
    );

    const transaction = new Transaction().add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer.publicKey,
        basePubkey: payer.publicKey,
        seed: GREETING_SEED,
        newAccountPubkey: greetedPubkey,
        lamports,
        space: GREETING_SIZE,
        programId,
      }),
    );
    await sendAndConfirmTransaction(connection, transaction, [payer]);
  }

  // Check if the custom account has already been created
  const customAccount = await connection.getAccountInfo(customPubkey);
    if (customAccount === null) {
      console.log(
        'Creating second account',
        greetedPubkey.toBase58(),
        'to say hello to',
      );
      const lamports = await connection.getMinimumBalanceForRentExemption(
        CUSTOM_ACCOUNT_SIZE,
      );

      const transaction2 = new Transaction().add(
        SystemProgram.createAccountWithSeed({
          fromPubkey: payer.publicKey,
          basePubkey: payer.publicKey,
          seed: CUSTOM_ACCOUNT_SEED,
          newAccountPubkey: customPubkey,
          lamports,
          space: CUSTOM_ACCOUNT_SIZE,
          programId,
        }),
      );
      await sendAndConfirmTransaction(connection, transaction2, [payer]);
    }
}

/**
 * Say hello
 */
export async function sayHello(): Promise<void> {
  console.log('Saying hello to', greetedPubkey.toBase58());
  console.log('Saying hello to', customPubkey.toBase58());
  const instruction = new TransactionInstruction({
    keys: [{pubkey: greetedPubkey, isSigner: false, isWritable: true}, {pubkey: customPubkey, isSigner: false, isWritable: true}],
    programId,
    data: createSayHelloInstructionData(), // All instructions are hellos
  });
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    [payer],
  );
}

/**
 * Create buffer
 */
function createSayHelloInstructionData(): Buffer {
  const dataLayout = BufferLayout.struct([
    BufferLayout.u8('A'),BufferLayout.u8('B')
  ],
  );

  const data = Buffer.alloc(dataLayout.span);
  dataLayout.encode({
    A: 2,
    B: 1
  }, data);
// console.log('data:------->', data )
  return data;
}

/**
 * Report the number of times the greeted account has been said hello to
 */
export async function reportGreetings(): Promise<void> {
  const accountInfo = await connection.getAccountInfo(greetedPubkey);
  if (accountInfo === null) {
    throw 'Error: cannot find the greeted account';
  }
  const greeting = borsh.deserialize(
    GreetingSchema,
    GreetingAccount,
    accountInfo.data,
  );
  console.log(
      programId.toBase58(),
      'computed sum: ',
      greeting.sum,
    );
}