/* eslint-disable no-param-reassign */
/* eslint-disable import/extensions */
import { poseidonHashMany } from 'micro-starknet';

import { API_VERSION, StarknetChainId, TransactionHashPrefix } from '../constants';
import {
  BigNumberish,
  Builtins,
  CompiledContract,
  CompiledSierra,
  CompiledSierraCasm,
  ContractEntryPointFields,
  LegacyCompiledContract,
  RawArgs,
  RawCalldata,
  SierraContractEntryPointFields,
} from '../types';
import { CallData } from './calldata';
import { felt } from './calldata/cairo';
import { starkCurve } from './ec';
import { addHexPrefix, utf8ToArray } from './encode';
import { parse, stringify } from './json';
import { toBigInt, toHex } from './num';
import { getSelectorFromName } from './selector';
import { encodeShortString } from './shortString';

export * as poseidon from '@noble/curves/abstract/poseidon';
export * from './selector'; // Preserve legacy export structure

export const transactionVersion = 1n;
export const transactionVersion_2 = 2n;
// TODO: check do we need to use feeTransactionVersion at all for feeEstimation ?
export const feeTransactionVersion = 2n ** 128n + transactionVersion;
export const feeTransactionVersion_2 = 2n ** 128n + transactionVersion_2;

/**
 * Return versions based on version type, default transaction versions
 * @param versionType 'fee' | 'transaction'
 * @returns versions { v1: bigint; v2: bigint; }
 */
export function getVersionsByType(versionType?: 'fee' | 'transaction') {
  return versionType === 'fee'
    ? { v1: feeTransactionVersion, v2: feeTransactionVersion_2 }
    : { v1: transactionVersion, v2: transactionVersion_2 };
}

export function computeHashOnElements(data: BigNumberish[]): string {
  return [...data, data.length]
    .reduce((x: BigNumberish, y: BigNumberish) => starkCurve.pedersen(toBigInt(x), toBigInt(y)), 0)
    .toString();
}

// following implementation is based on this python implementation:
// https://github.com/starkware-libs/cairo-lang/blob/b614d1867c64f3fb2cf4a4879348cfcf87c3a5a7/src/starkware/starknet/core/os/transaction_hash/transaction_hash.py

export function calculateTransactionHashCommon(
  txHashPrefix: TransactionHashPrefix,
  version: BigNumberish,
  contractAddress: BigNumberish,
  entryPointSelector: BigNumberish,
  calldata: RawCalldata,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  additionalData: BigNumberish[] = []
): string {
  const calldataHash = computeHashOnElements(calldata);
  const dataToHash = [
    txHashPrefix,
    version,
    contractAddress,
    entryPointSelector,
    calldataHash,
    maxFee,
    chainId,
    ...additionalData,
  ];
  return computeHashOnElements(dataToHash);
}

export function calculateDeployTransactionHash(
  contractAddress: BigNumberish,
  constructorCalldata: RawCalldata,
  version: BigNumberish,
  chainId: StarknetChainId
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.DEPLOY,
    version,
    contractAddress,
    getSelectorFromName('constructor'),
    constructorCalldata,
    0,
    chainId
  );
}

export function calculateDeclareTransactionHash(
  classHash: string,
  senderAddress: BigNumberish,
  version: BigNumberish,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish,
  compiledClassHash?: string
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.DECLARE,
    version,
    senderAddress,
    0,
    [classHash],
    maxFee,
    chainId,
    [nonce, ...(compiledClassHash ? [compiledClassHash] : [])]
  );
}

export function calculateDeployAccountTransactionHash(
  contractAddress: BigNumberish,
  classHash: BigNumberish,
  constructorCalldata: RawCalldata,
  salt: BigNumberish,
  version: BigNumberish,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish
) {
  const calldata = [classHash, salt, ...constructorCalldata];

  return calculateTransactionHashCommon(
    TransactionHashPrefix.DEPLOY_ACCOUNT,
    version,
    contractAddress,
    0,
    calldata,
    maxFee,
    chainId,
    [nonce]
  );
}

export function calculateTransactionHash(
  contractAddress: BigNumberish,
  version: BigNumberish,
  calldata: RawCalldata,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.INVOKE,
    version,
    contractAddress,
    0,
    calldata,
    maxFee,
    chainId,
    [nonce]
  );
}

export function calculateContractAddressFromHash(
  salt: BigNumberish,
  classHash: BigNumberish,
  constructorCalldata: RawArgs,
  deployerAddress: BigNumberish
) {
  const compiledCalldata = CallData.compile(constructorCalldata);
  const constructorCalldataHash = computeHashOnElements(compiledCalldata);

  const CONTRACT_ADDRESS_PREFIX = felt('0x535441524b4e45545f434f4e54524143545f41444452455353'); // Equivalent to 'STARKNET_CONTRACT_ADDRESS'

  return computeHashOnElements([
    CONTRACT_ADDRESS_PREFIX,
    deployerAddress,
    salt,
    classHash,
    constructorCalldataHash,
  ]);
}

function nullSkipReplacer(key: string, value: any) {
  if (key === 'attributes' || key === 'accessible_scopes') {
    return Array.isArray(value) && value.length === 0 ? undefined : value;
  }

  if (key === 'debug_info') {
    return null;
  }

  return value === null ? undefined : value;
}

// about 10x to 100x faster using array to build string
export function formatSpaces(json: string) {
  let insideQuotes = false;
  const newString = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const char of json) {
    if (char === '"' && (newString.length > 0 && newString.slice(-1)[0] === '\\') === false) {
      insideQuotes = !insideQuotes;
    }
    if (insideQuotes) {
      newString.push(char);
    } else {
      // eslint-disable-next-line no-nested-ternary
      newString.push(char === ':' ? ': ' : char === ',' ? ', ' : char);
    }
  }
  return newString.join('');
}

export default function computeHintedClassHash(compiledContract: LegacyCompiledContract) {
  const { abi, program } = compiledContract;
  const contractClass = { abi, program };
  const serializedJson = formatSpaces(stringify(contractClass, nullSkipReplacer));

  return addHexPrefix(starkCurve.keccak(utf8ToArray(serializedJson)).toString(16));
}

// Computes the class hash of a given contract class
export function computeLegacyContractClassHash(contract: LegacyCompiledContract | string) {
  const compiledContract =
    typeof contract === 'string' ? (parse(contract) as LegacyCompiledContract) : contract;

  const apiVersion = toHex(API_VERSION);

  const externalEntryPointsHash = computeHashOnElements(
    compiledContract.entry_points_by_type.EXTERNAL.flatMap((e) => [e.selector, e.offset])
  );

  const l1HandlerEntryPointsHash = computeHashOnElements(
    compiledContract.entry_points_by_type.L1_HANDLER.flatMap((e) => [e.selector, e.offset])
  );

  const constructorEntryPointHash = computeHashOnElements(
    compiledContract.entry_points_by_type.CONSTRUCTOR.flatMap((e) => [e.selector, e.offset])
  );

  const builtinsHash = computeHashOnElements(
    compiledContract.program.builtins.map((s) => encodeShortString(s))
  );

  const hintedClassHash = computeHintedClassHash(compiledContract);

  const dataHash = computeHashOnElements(compiledContract.program.data);

  return computeHashOnElements([
    apiVersion,
    externalEntryPointsHash,
    l1HandlerEntryPointsHash,
    constructorEntryPointHash,
    builtinsHash,
    hintedClassHash,
    dataHash,
  ]);
}

// Cairo1 below
function hashBuiltins(builtins: Builtins) {
  return poseidonHashMany(
    builtins.flatMap((it: any) => {
      return BigInt(encodeShortString(it));
    })
  );
}

function hashEntryPoint(data: ContractEntryPointFields[]) {
  const base = data.flatMap((it: any) => {
    return [BigInt(it.selector), BigInt(it.offset), hashBuiltins(it.builtins)];
  });
  return poseidonHashMany(base);
}

export function computeCompiledClassHash(casm: CompiledSierraCasm) {
  const COMPILED_CLASS_VERSION = 'COMPILED_CLASS_V1';

  // Hash compiled class version
  const compiledClassVersion = BigInt(encodeShortString(COMPILED_CLASS_VERSION));

  // Hash external entry points.
  const externalEntryPointsHash = hashEntryPoint(casm.entry_points_by_type.EXTERNAL);

  // Hash L1 handler entry points.
  const l1Handlers = hashEntryPoint(casm.entry_points_by_type.L1_HANDLER);

  // Hash constructor entry points.
  const constructor = hashEntryPoint(casm.entry_points_by_type.CONSTRUCTOR);

  // Hash bytecode.
  const bytecode = poseidonHashMany(casm.bytecode.map((it: string) => BigInt(it)));

  return toHex(
    poseidonHashMany([
      compiledClassVersion,
      externalEntryPointsHash,
      l1Handlers,
      constructor,
      bytecode,
    ])
  );
}

function hashEntryPointSierra(data: SierraContractEntryPointFields[]) {
  const base = data.flatMap((it: any) => {
    return [BigInt(it.selector), BigInt(it.function_idx)];
  });
  return poseidonHashMany(base);
}

function hashAbi(sierra: CompiledSierra) {
  const indentString = formatSpaces(stringify(sierra.abi, null));
  return BigInt(addHexPrefix(starkCurve.keccak(utf8ToArray(indentString)).toString(16)));
}

export function computeSierraContractClassHash(sierra: CompiledSierra) {
  const CONTRACT_CLASS_VERSION = 'CONTRACT_CLASS_V0.1.0';

  // Hash class version
  const compiledClassVersion = BigInt(encodeShortString(CONTRACT_CLASS_VERSION));

  // Hash external entry points.
  const externalEntryPointsHash = hashEntryPointSierra(sierra.entry_points_by_type.EXTERNAL);

  // Hash L1 handler entry points.
  const l1Handlers = hashEntryPointSierra(sierra.entry_points_by_type.L1_HANDLER);

  // Hash constructor entry points.
  const constructor = hashEntryPointSierra(sierra.entry_points_by_type.CONSTRUCTOR);

  // Hash abi_hash.
  const abiHash = hashAbi(sierra);

  // Hash Sierra program.
  const sierraProgram = poseidonHashMany(sierra.sierra_program.map((it: string) => BigInt(it)));

  return toHex(
    poseidonHashMany([
      compiledClassVersion,
      externalEntryPointsHash,
      l1Handlers,
      constructor,
      abiHash,
      sierraProgram,
    ])
  );
}

/**
 * Compute ClassHash (sierra or legacy) based on provided contract
 * @param contract CompiledContract | CompiledSierra | string
 * @returns HexString ClassHash
 */
export function computeContractClassHash(contract: CompiledContract | string) {
  const compiledContract = typeof contract === 'string' ? parse(contract) : contract;

  if ('sierra_program' in compiledContract) {
    return computeSierraContractClassHash(compiledContract as CompiledSierra);
  }

  return computeLegacyContractClassHash(compiledContract as LegacyCompiledContract);
}
