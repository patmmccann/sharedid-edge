/**
 * Just enough of a TCF v2 TC string to check consent: the core segment's version, purpose consents, purpose
 * legitimate interests and vendor consents, and the publisher TC segment's purpose consents and legitimate interests. A full decoder is much larger than this worker needs.
 *
 * Core segment layout (bit offsets): Version 0-5, Created 6-41, LastUpdated 42-77, CmpId 78-89, CmpVersion 90-101,
 * ConsentScreen 102-107, ConsentLanguage 108-119, VendorListVersion 120-131, TcfPolicyVersion 132-137,
 * IsServiceSpecific 138, UseNonStandardTexts 139, SpecialFeatureOptIns 140-151, PurposesConsent 152-175,
 * PurposesLITransparency 176-199, PurposeOneTreatment 200, PublisherCC 201-212, then the vendor consent section:
 * MaxVendorId 213-228, IsRangeEncoding 229, then either a bit field (one bit per vendor, 1 to MaxVendorId) or NumEntries
 * (12 bits) followed by entries of IsARange (1 bit), StartOrOnlyVendorId (16) and, for a range, EndVendorId (16).
 *
 * Publisher TC segment layout: SegmentType 0-2 (3 for this segment), PubPurposesConsent 3-26,
 * PubPurposesLITransparency 27-50, then custom purposes.
 */
export interface TcfConsents {
  readonly version: number;
  /** Purposes (1-24) the user consented to for vendors (the core segment). */
  readonly purposeConsents: ReadonlySet<number>;
  /** Purposes (1-24) with legitimate interest established for vendors (the core segment). */
  readonly purposeLegitimateInterests: ReadonlySet<number>;
  /** Whether the user consented to a vendor, by Global Vendor List ID (the core segment's vendor consent section). */
  readonly vendorConsent: (vendorId: number) => boolean;
  /**
   * Purposes (1-24) the user consented to for the publisher (the publisher TC segment), or undefined when the string
   * has no publisher TC segment.
   */
  readonly publisherPurposeConsents: ReadonlySet<number> | undefined;
  /** Purposes (1-24) with legitimate interest established for the publisher, or undefined without a publisher TC segment. */
  readonly publisherPurposeLegitimateInterests: ReadonlySet<number> | undefined;
}

const CORE_PURPOSES_OFFSET = 152;
const CORE_LI_OFFSET = 176;
const VENDOR_SECTION_OFFSET = 213;
const PUBLISHER_SEGMENT_TYPE = 3;
const PUBLISHER_PURPOSES_OFFSET = 3;
const PUBLISHER_LI_OFFSET = 27;
const PURPOSES_LENGTH = 24;
const MAX_LENGTH = 8192;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The purpose consents in a TC string, or undefined if the string isn't a valid TCF v2 TC string. */
export function decodeTcf(tcString: string): TcfConsents | undefined {
  if (tcString.length > MAX_LENGTH) return undefined;
  const [core, ...segments] = tcString.split('.');
  const coreBits = core === undefined ? undefined : toBits(core);
  if (coreBits === undefined || coreBits.length < CORE_LI_OFFSET + PURPOSES_LENGTH) return undefined;
  const version = readInt(coreBits, 0, 6);
  if (version !== 2) return undefined;

  let publisherPurposeConsents: ReadonlySet<number> | undefined;
  let publisherPurposeLegitimateInterests: ReadonlySet<number> | undefined;
  for (const segment of segments) {
    const bits = toBits(segment);
    if (bits === undefined) return undefined;
    if (bits.length >= PUBLISHER_LI_OFFSET + PURPOSES_LENGTH && readInt(bits, 0, 3) === PUBLISHER_SEGMENT_TYPE) {
      publisherPurposeConsents = readPurposes(bits, PUBLISHER_PURPOSES_OFFSET);
      publisherPurposeLegitimateInterests = readPurposes(bits, PUBLISHER_LI_OFFSET);
    }
  }
  return {
    version,
    purposeConsents: readPurposes(coreBits, CORE_PURPOSES_OFFSET),
    purposeLegitimateInterests: readPurposes(coreBits, CORE_LI_OFFSET),
    vendorConsent: readVendorConsents(coreBits),
    publisherPurposeConsents,
    publisherPurposeLegitimateInterests
  };
}

/** The vendor consent section as a lookup. A missing or truncated section consents to no vendor it doesn't cover. */
function readVendorConsents(bits: readonly number[]): (vendorId: number) => boolean {
  let offset = VENDOR_SECTION_OFFSET;
  const maxVendorId = readInt(bits, offset, 16);
  const isRangeEncoding = bits[offset + 16] === 1;
  offset += 17;
  if (!isRangeEncoding) {
    const start = offset;
    return vendorId => Number.isInteger(vendorId) && vendorId >= 1 && vendorId <= maxVendorId && bits[start + vendorId - 1] === 1;
  }
  const ranges: (readonly [number, number])[] = [];
  const entries = readInt(bits, offset, 12);
  offset += 12;
  for (let i = 0; i < entries && offset < bits.length; i++) {
    const isRange = bits[offset] === 1;
    const first = readInt(bits, offset + 1, 16);
    const last = isRange ? readInt(bits, offset + 17, 16) : first;
    offset += isRange ? 33 : 17;
    ranges.push([first, last]);
  }
  return vendorId => vendorId <= maxVendorId && ranges.some(([first, last]) => vendorId >= first && vendorId <= last);
}

function toBits(segment: string): number[] | undefined {
  if (segment.length === 0) return undefined;
  const bits: number[] = [];
  for (const char of segment) {
    const value = BASE64URL.indexOf(char === '+' ? '-' : char === '/' ? '_' : char);
    if (value < 0) {
      if (char === '=') break;
      return undefined;
    }
    for (let bit = 5; bit >= 0; bit--) bits.push((value >> bit) & 1);
  }
  return bits;
}

function readPurposes(bits: readonly number[], offset: number): Set<number> {
  const purposes = new Set<number>();
  for (let i = 0; i < PURPOSES_LENGTH; i++) {
    if (bits[offset + i] === 1) purposes.add(i + 1);
  }
  return purposes;
}

function readInt(bits: readonly number[], offset: number, length: number): number {
  let value = 0;
  for (let i = offset; i < offset + length; i++) value = value * 2 + (bits[i] ?? 0);
  return value;
}
