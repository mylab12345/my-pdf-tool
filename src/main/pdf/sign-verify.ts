import forge from 'node-forge';
import type { SignatureVerification } from '../../shared/types';

/**
 * PKCS#7 / CMS signature verification for signed PDFs.
 *
 * node-forge can create PKCS#7 signatures but does not implement verification,
 * so the SignedData structure is parsed here and the two checks required by
 * RFC 5652 are performed:
 *
 *   1. the `messageDigest` attribute equals the digest of the byte ranges that
 *      the PDF declares in `/ByteRange` (integrity of the document), and
 *   2. the signature over the DER-encoded `signedAttrs` validates against the
 *      public key of the embedded certificate (authenticity).
 */

const OID = {
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
} as const;

const DIGEST_NAMES: Record<string, 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
  [OID.sha1]: 'sha1',
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};

export interface PdfSignatureBlocks {
  byteRange: number[];
  contents: Uint8Array;
  subFilter?: string;
  signingReason?: string;
  signingLocation?: string;
  signingName?: string;
}

/** Extracts the signature dictionary data from a signed PDF. */
export function readSignatureBlocks(bytes: Uint8Array): PdfSignatureBlocks | null {
  const text = latin1(bytes);
  const rangeMatch = text.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
  if (!rangeMatch) return null;
  const byteRange = rangeMatch.slice(1, 5).map(Number);

  const contentsIndex = text.indexOf('/Contents', rangeMatch.index ?? 0);
  if (contentsIndex < 0) return null;
  const open = text.indexOf('<', contentsIndex);
  const close = text.indexOf('>', open);
  if (open < 0 || close < 0) return null;
  let hex = text.slice(open + 1, close).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length % 2 === 1) hex = hex.slice(0, -1);
  const decoded = hexToBytes(hex);
  // Trim zero padding added by the placeholder.
  let end = decoded.length;
  while (end > 0 && decoded[end - 1] === 0) end -= 1;
  const contents = decoded.subarray(0, end);

  // The signature dictionary surrounds /Contents; scan a window that also covers
  // keys written after it (placeholder implementations differ).
  const dictStart = Math.max(0, text.lastIndexOf('<<', contentsIndex - 1));
  const dictEnd = Math.min(text.length, close + 4096);
  const dictText = text.slice(dictStart, dictEnd);
  const subFilter = dictText.match(/\/SubFilter\s*\/([A-Za-z0-9._-]+)/)?.[1];
  const reason = pdfTextValue(dictText, 'Reason');
  const location = pdfTextValue(dictText, 'Location');
  const name = pdfTextValue(dictText, 'Name');
  return {
    byteRange,
    contents,
    ...(subFilter ? { subFilter } : {}),
    ...(reason ? { signingReason: reason } : {}),
    ...(location ? { signingLocation: location } : {}),
    ...(name ? { signingName: name } : {}),
  };
}

/** Verifies the (first) signature of a signed PDF. */
export function verifyPdfSignature(bytes: Uint8Array): SignatureVerification {
  const messages: string[] = [];
  const blocks = readSignatureBlocks(bytes);
  if (!blocks) {
    return { signed: false, valid: false, integrityOk: false, messages: ['No signature found in this document.'] };
  }
  const [start1, length1, start2, length2] = blocks.byteRange;
  const signedContent = concat(
    bytes.subarray(start1 ?? 0, (start1 ?? 0) + (length1 ?? 0)),
    bytes.subarray(start2 ?? 0, (start2 ?? 0) + (length2 ?? 0)),
  );
  // The signed ranges must cover everything except the /Contents hole.
  const expected = bytes.length - (blocks.contents.length + 2);
  if ((length1 ?? 0) + (length2 ?? 0) < expected - 64) {
    messages.push('The signed byte ranges do not cover the whole file; the document was modified after signing.');
  }

  try {
    const parsed = parseSignedData(blocks.contents);
    if (!parsed) {
      return {
        signed: true,
        valid: false,
        integrityOk: false,
        messages: [...messages, 'The embedded signature is not a PKCS#7 SignedData structure.'],
      };
    }
    const { signer, certificates } = parsed;
    const md = forge.md[DIGEST_NAMES[signer.digestAlgorithm] ?? 'sha256'].create();
    md.update(binaryString(signedContent));
    const contentDigest = md.digest().getBytes();

    const integrityOk = signer.messageDigest !== undefined && signer.messageDigest === contentDigest;
    messages.push(
      integrityOk
        ? 'The document content matches the signed digest.'
        : 'The document content does not match the signed digest (it was altered).',
    );

    let signatureValid = false;
    const certificate = matchCertificate(certificates, signer.serialNumber, signer.issuerDer);
    if (!certificate) {
      messages.push('The signing certificate is not embedded in the signature.');
    } else if (signer.signedAttributesDer && signer.signature) {
      try {
        const attrsDigest = forge.md[DIGEST_NAMES[signer.digestAlgorithm] ?? 'sha256'].create();
        attrsDigest.update(binaryString(signer.signedAttributesDer));
        const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
        signatureValid = publicKey.verify(attrsDigest.digest().getBytes(), binaryString(signer.signature));
        messages.push(signatureValid ? 'The signature validates against the signer certificate.' : 'The signature does not validate against the signer certificate.');
      } catch (error) {
        messages.push(`Signature verification failed: ${(error as Error).message}`);
      }
    }

    const now = Date.now();
    const validFrom = certificate?.validity?.notBefore ?? null;
    const validTo = certificate?.validity?.notAfter ?? null;
    if (validFrom && validTo) {
      if (now < validFrom.getTime()) messages.push('The certificate is not valid yet.');
      if (now > validTo.getTime()) messages.push('The certificate has expired.');
    }
    const selfSigned = certificate ? certificate.issuer.attributes.every((attr, index) => {
      const subject = certificate.subject.attributes[index];
      return subject && subject.value === attr.value;
    }) : false;

    const result: SignatureVerification = {
      signed: true,
      valid: integrityOk && signatureValid,
      integrityOk,
      messages,
      ...(certificate
        ? {
            signerName: certificate.subject.getField('CN')?.value ?? certificate.subject.attributes.map((attr) => String(attr.value)).join(', '),
            issuer: certificate.issuer.getField('CN')?.value ?? certificate.issuer.attributes.map((attr) => String(attr.value)).join(', '),
            certificateValidFrom: (validFrom ?? new Date(0)).toISOString(),
            certificateValidTo: (validTo ?? new Date(0)).toISOString(),
            selfSigned,
          }
        : {}),
      ...(signer.signingTime ? { signingTime: signer.signingTime } : {}),
      ...(blocks.signingReason ? { reason: blocks.signingReason } : {}),
      ...(blocks.signingLocation ? { location: blocks.signingLocation } : {}),
      algorithm: DIGEST_NAMES[signer.digestAlgorithm] ?? signer.digestAlgorithm,
    };
    return result;
  } catch (error) {
    return {
      signed: true,
      valid: false,
      integrityOk: false,
      messages: [...messages, `The signature could not be parsed: ${(error as Error).message}`],
    };
  }
}

interface ParsedSigner {
  digestAlgorithm: string;
  messageDigest?: string;
  signingTime?: string;
  signature?: Uint8Array;
  signedAttributesDer?: Uint8Array;
  serialNumber?: string;
  issuerDer?: Uint8Array;
}

interface ParsedSignedData {
  signer: ParsedSigner;
  certificates: forge.pki.Certificate[];
}

/** Minimal ASN.1 walker for CMS SignedData (RFC 5652). */
function parseSignedData(der: Uint8Array): ParsedSignedData | null {
  const root = forge.asn1.fromDer(binaryString(der), false) as forge.asn1.Asn1;
  if (root.type !== forge.asn1.Type.SEQUENCE) return null;
  const contentInfo = root.value as forge.asn1.Asn1[];
  if (contentInfo.length < 2) return null;
  const explicit = contentInfo[1];
  if (!explicit || !Array.isArray(explicit.value) || !explicit.value.length) return null;
  const signedData = explicit.value[0] as forge.asn1.Asn1;
  if (!signedData || !Array.isArray(signedData.value)) return null;

  const elements = signedData.value as forge.asn1.Asn1[];
  const certificatesNode = elements.find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0);
  const signerInfosNode = [...elements].reverse().find((node) => node.type === forge.asn1.Type.SET);
  if (!signerInfosNode || !Array.isArray(signerInfosNode.value)) return null;

  const certificates: forge.pki.Certificate[] = [];
  if (certificatesNode && Array.isArray(certificatesNode.value)) {
    for (const node of certificatesNode.value as forge.asn1.Asn1[]) {
      try {
        certificates.push(forge.pki.certificateFromAsn1(node));
      } catch {
        /* skip unsupported certificate types */
      }
    }
  }

  const signerInfo = (signerInfosNode.value as forge.asn1.Asn1[])[0];
  if (!signerInfo || !Array.isArray(signerInfo.value)) return null;
  const parts = signerInfo.value as forge.asn1.Asn1[];

  let index = 0;
  index += 1; // version
  const sid = parts[index++]!;
  const digestAlgorithmNode = parts[index++]!;
  let signedAttrs: forge.asn1.Asn1 | undefined;
  if (parts[index] && parts[index]!.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && parts[index]!.type === 0) {
    signedAttrs = parts[index];
    index += 1;
  }
  index += 1; // signatureAlgorithm
  const signatureNode = parts[index];

  const digestOid = digestAlgorithmNode.value?.[0]
    ? forge.asn1.derToOid((digestAlgorithmNode.value as forge.asn1.Asn1[])[0]!.value as string)
    : OID.sha256;

  const signer: ParsedSigner = { digestAlgorithm: digestOid };

  if (sid.type === forge.asn1.Type.SEQUENCE && Array.isArray(sid.value)) {
    const issuerAndSerial = sid.value as forge.asn1.Asn1[];
    const serial = issuerAndSerial[1];
    if (serial) signer.serialNumber = bytesToHex(forge.asn1.toDer(serial).getBytes()).replace(/^00/, '').toLowerCase();
    const issuer = issuerAndSerial[0];
    if (issuer) signer.issuerDer = binaryToBytes(forge.asn1.toDer(issuer).getBytes());
  }

  if (signatureNode && signatureNode.type === forge.asn1.Type.OCTETSTRING) {
    signer.signature = binaryToBytes(signatureNode.value as string);
  }

  if (signedAttrs && Array.isArray(signedAttrs.value)) {
    // Signed attributes are hashed as an explicit SET OF, not with the [0] tag.
    const asSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, signedAttrs.value as forge.asn1.Asn1[]);
    signer.signedAttributesDer = binaryToBytes(forge.asn1.toDer(asSet).getBytes());
    for (const attribute of signedAttrs.value as forge.asn1.Asn1[]) {
      if (!Array.isArray(attribute.value)) continue;
      const oidNode = (attribute.value as forge.asn1.Asn1[])[0];
      const valuesNode = (attribute.value as forge.asn1.Asn1[])[1];
      if (!oidNode || !valuesNode || !Array.isArray(valuesNode.value)) continue;
      const oid = forge.asn1.derToOid(oidNode.value as string);
      const valueNode = (valuesNode.value as forge.asn1.Asn1[])[0];
      if (!valueNode) continue;
      if (oid === OID.messageDigest && valueNode.type === forge.asn1.Type.OCTETSTRING) {
        signer.messageDigest = valueNode.value as string;
      }
      if (oid === OID.signingTime && valueNode.type === forge.asn1.Type.UTCTIME) {
        signer.signingTime = forge.asn1.utcTimeToDate(valueNode.value as string).toISOString();
      }
    }
  }

  return { signer, certificates };
}

function matchCertificate(
  certificates: forge.pki.Certificate[],
  serialNumber?: string,
  issuerDer?: Uint8Array,
): forge.pki.Certificate | undefined {
  if (!certificates.length) return undefined;
  if (serialNumber) {
    const bySerial = certificates.find((certificate) => certificate.serialNumber.replace(/^0+/, '').toLowerCase() === serialNumber.replace(/^0+/, ''));
    if (bySerial) return bySerial;
  }
  if (issuerDer) {
    const issuer = binaryString(issuerDer);
    const byIssuer = certificates.find((certificate) => {
      try {
        const certIssuerDer = forge.asn1.toDer(forge.pki.distinguishedNameToAsn1(certificate.issuer)).getBytes();
        return certIssuerDer === issuer;
      } catch {
        return false;
      }
    });
    if (byIssuer) return byIssuer;
  }
  return certificates[0];
}

/** Reads a PDF text value that is either a literal or a hex string. */
function pdfTextValue(dictText: string, key: string): string | undefined {
  const literal = dictText.match(new RegExp(`/${key}\\s*\\(([^)]*)\\)`));
  if (literal) return unescapePdfText(literal[1] ?? '');
  const hex = dictText.match(new RegExp(`/${key}\\s*<([0-9a-fA-F\\s]+)>`));
  if (hex) {
    const cleaned = (hex[1] ?? '').replace(/\s+/g, '');
    try {
      const bytes = hexToBytes(cleaned.length % 2 ? `${cleaned}0` : cleaned);
      return new TextDecoder('utf-16be').decode(bytes);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function unescapePdfText(value: string): string {
  return value.replace(/\\([nrtbf()\\])/g, (_match, char: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return map[char] ?? char;
  });
}

/* -------------------------------------------------------------------------- */
/* Byte helpers                                                                */
/* -------------------------------------------------------------------------- */

function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    out += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return out;
}

function binaryString(bytes: Uint8Array): string {
  return latin1(bytes);
}

function binaryToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToHex(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) out += value.charCodeAt(index).toString(16).padStart(2, '0');
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
