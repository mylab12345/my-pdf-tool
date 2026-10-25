import forge from 'node-forge';
import { plainAddPlaceholder } from '@signpdf/placeholder-plain';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import type { CreatedCertificate, SignatureOptions } from '../../shared/types';
import { appError } from '../../core/errors';
import { loadPdf, savePdf } from '../../core/pdf/loader';
import { addImageStamp } from '../../core/pdf/annotations';

/**
 * Signs a PDF.
 *
 * - `digital: false` places a visible signature image only (a drawn/typed
 *   signature burned into the page content).
 * - `digital: true` additionally creates a detached PKCS#7 signature
 *   (`adbe.pkcs7.detached`, PAdES B-B level), validated by the built-in
 *   verifier and by standard readers.
 *
 * The placeholder injection step requires a classic cross-reference table, so the
 * document is re-saved without object streams before signing. Signing itself is
 * always the last step: the signature covers the final bytes.
 */
export async function signDocument(bytes: Uint8Array, options: SignatureOptions): Promise<Uint8Array> {
  let working = bytes;

  if (options.image) {
    const doc = await loadPdf(working);
    const pageIndex = Math.max(0, Math.min(doc.getPageCount() - 1, options.pageIndex));
    await addImageStamp(doc, pageIndex, options.rect, decodeImage(options.image));
    working = await savePdf(doc);
  }

  if (!options.digital) {
    if (!options.image) throw appError('INVALID_INPUT', 'Choose a signature image or enable digital signing.');
    return working;
  }

  if (!options.p12) throw appError('INVALID_INPUT', 'A PKCS#12 certificate is required for digital signing.');
  const p12 = decodeBase64(options.p12);
  if (!p12.length) throw appError('SIGNATURE_FAILED', 'The certificate file could not be read.');

  // Signature placeholders need a classic xref table.
  const doc = await loadPdf(working);
  const normalized = await savePdf(doc, { useObjectStreams: false });

  let withPlaceholder: Buffer;
  try {
    withPlaceholder = plainAddPlaceholder({
      pdfBuffer: Buffer.from(normalized),
      reason: options.reason || 'Signed with Arena PDF Studio',
      location: options.location || '',
      name: options.signerName || '',
      contactInfo: options.contactInfo || '',
    });
  } catch (error) {
    throw appError('SIGNATURE_FAILED', 'The signature placeholder could not be added to this document.', {
      details: (error as Error).message,
      hint: 'Re-save the document (Save a copy) and try signing again.',
    });
  }

  try {
    const signer = new P12Signer(Buffer.from(p12), { passphrase: options.p12Password ?? '' });
    const signed = await new SignPdf().sign(withPlaceholder, signer);
    return new Uint8Array(signed);
  } catch (error) {
    throw appError('SIGNATURE_FAILED', 'The document could not be signed.', {
      details: (error as Error).message,
      hint: 'Check the certificate password. Password-protected (encrypted) documents must be decrypted before signing.',
    });
  }
}

/** Creates a self-signed certificate + PKCS#12 keystore for signing. */
export function createSelfSignedCertificate(options: {
  name: string;
  organization?: string;
  email?: string;
  password: string;
  years: number;
}): CreatedCertificate {
  if (!options.name.trim()) throw appError('INVALID_INPUT', 'Enter the name shown on the certificate.');
  if ((options.password ?? '').length < 6) throw appError('INVALID_INPUT', 'Choose a keystore password of at least 6 characters.');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${Date.now().toString(16).slice(-10)}`;
  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + Math.max(1, options.years) * 365 * 24 * 3600 * 1000);

  const attributes: forge.pki.CertificateField[] = [
    { name: 'commonName', value: options.name },
    { name: 'organizationName', value: options.organization || options.name },
    { shortName: 'OU', value: 'Digital signature' },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: false },
    { name: 'extKeyUsage', emailProtection: true, clientAuth: true },
    ...(options.email ? [{ name: 'subjectAltName', altNames: [{ type: 1, value: options.email }] }] : []),
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], options.password, { algorithm: '3des', friendlyName: options.name });
  const p12 = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
  const pem = forge.pki.certificateToPem(cert);
  const fingerprint = forge.md.sha1.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()).digest().toHex();

  return {
    p12: p12.toString('base64'),
    fingerprint: fingerprint.match(/.{2}/g)?.join(':').toUpperCase() ?? fingerprint,
    subject: cert.subject.getField('CN')?.value ?? options.name,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    pem,
  };
}

export { verifyPdfSignature } from './sign-verify';

function decodeBase64(value: string): Uint8Array {
  const clean = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

function decodeImage(value: string): Uint8Array {
  return decodeBase64(value);
}
