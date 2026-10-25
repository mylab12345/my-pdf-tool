import { describe, expect, it } from 'vitest';
import { createSelfSignedCertificate, signDocument, verifyPdfSignature } from '../../src/main/pdf/sign';
import { loadPdf } from '../../src/core/pdf/loader';
import { listAnnotations } from '../../src/core/pdf/annotations';
import { makePdf, pngBytes } from './helpers';

describe('digital signatures', () => {
  it('creates a self-signed PKCS#12 certificate', () => {
    const certificate = createSelfSignedCertificate({
      name: 'Ada Lovelace',
      organization: 'Arena',
      email: 'ada@example.invalid',
      password: 'keystore-password',
      years: 2,
    });
    expect(certificate.p12.length).toBeGreaterThan(1000);
    expect(certificate.subject).toBe('Ada Lovelace');
    expect(certificate.fingerprint).toMatch(/^([0-9A-F]{2}:){19}[0-9A-F]{2}$/);
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(certificate.pem).toContain('BEGIN CERTIFICATE');
  });

  it('signs a document and verifies the signature end to end', async () => {
    const certificate = createSelfSignedCertificate({
      name: 'Signer One',
      password: 'p12-passphrase',
      years: 1,
    });
    const signed = await signDocument(await makePdf({ pages: 2 }), {
      digial: false,
      pages: undefined,
      digital: true,
      p12: certificate.p12,
      p12Password: 'p12-passphrase',
      reason: 'Approved for release',
      location: 'Pune',
      signerName: 'Signer One',
      contactInfo: 'signer@example.invalid',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    } as never);

    const verification = verifyPdfSignature(signed);
    expect(verification.signed).toBe(true);
    expect(verification.integrityOk).toBe(true);
    expect(verification.valid).toBe(true);
    expect(verification.signerName).toBe('Signer One');
    expect(verification.selfSigned).toBe(true);
    expect(verification.reason).toBe('Approved for release');
    expect(verification.algorithm).toBe('sha256');
    expect(verification.messages.join(' ')).toContain('validates');

    // Still a readable PDF with the original pages.
    const doc = await loadPdf(signed);
    expect(doc.getPageCount()).toBe(2);
  }, 60_000);

  it('adds a visible signature image', async () => {
    const certificate = createSelfSignedCertificate({ name: 'Visible Signer', password: 'secret123', years: 1 });
    const signed = await signDocument(await makePdf(), {
      digital: true,
      p12: certificate.p12,
      p12Password: 'secret123',
      image: `data:image/png;base64,${Buffer.from(pngBytes(240, 80, '#0f172a')).toString('base64')}`,
      pageIndex: 0,
      rect: { x: 80, y: 120, width: 240, height: 80 },
      signerName: 'Visible Signer',
    });
    const verification = verifyPdfSignature(signed);
    expect(verification.valid).toBe(true);
    expect(listAnnotations(await loadPdf(signed))).toHaveLength(0);
    // The image is burned into the content stream, so the document grew.
    expect(signed.byteLength).toBeGreaterThan(2000);
  }, 60_000);

  it('detects tampering after signing', async () => {
    const certificate = createSelfSignedCertificate({ name: 'Tamper Test', password: 'p12-passphrase', years: 1 });
    const signed = await signDocument(await makePdf(), {
      digital: true,
      p12: certificate.p12,
      p12Password: 'p12-passphrase',
      pageIndex: 0,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      signerName: 'Tamper Test',
    });
    const tampered = new Uint8Array(signed);
    // Flip a byte inside the signed range (page content), not the signature hole.
    tampered[200] = tampered[200]! ^ 0xff;
    const verification = verifyPdfSignature(tampered);
    expect(verification.signed).toBe(true);
    expect(verification.integrityOk).toBe(false);
    expect(verification.valid).toBe(false);
  }, 60_000);

  it('reports unsigned documents', async () => {
    const verification = verifyPdfSignature(await makePdf());
    expect(verification.signed).toBe(false);
    expect(verification.valid).toBe(false);
  });

  it('fails cleanly with a wrong certificate password', async () => {
    const certificate = createSelfSignedCertificate({ name: 'Wrong Password', password: 'correct-password', years: 1 });
    await expect(
      signDocument(await makePdf(), {
        digital: true,
        p12: certificate.p12,
        p12Password: 'nope',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0, height: 0 },
      }),
    ).rejects.toMatchObject({ code: 'SIGNATURE_FAILED' });
  }, 60_000);
});
