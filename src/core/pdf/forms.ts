import {
  PDFName,
  PDFButton,
  PDFCheckBox,
  PDFDropdown,
  PDFField,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFDocument,
  type PDFFont,
  type PDFForm,
} from '@cantoo/pdf-lib';
import type { FillValue, FormFieldInfo, FormFieldType } from '../../shared/types';
import { appError } from '../errors';
import type { FormCreateField } from '../../shared/ipc';

function fieldType(field: PDFField): FormFieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/** Finds the page index a widget belongs to (best effort). */
function pageIndexOf(doc: PDFDocument, field: PDFField): number | null {
  try {
    const widgets = field.acroField.getWidgets();
    const widget = widgets[0];
    if (!widget) return null;
    for (const [index, page] of doc.getPages().entries()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let a = 0; a < annots.size(); a += 1) {
        if (annots.lookup(a) === widget.dict) return index;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function listFormFields(doc: PDFDocument): FormFieldInfo[] {
  let form: PDFForm;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  const fields: FormFieldInfo[] = [];
  for (const field of form.getFields()) {
    const type = fieldType(field);
    const info: FormFieldInfo = {
      name: field.getName(),
      type,
      value: readValue(field),
      required: field.isRequired(),
      readOnly: field.isReadOnly(),
      pageIndex: pageIndexOf(doc, field),
      rect: null,
    };
    try {
      const widget = field.acroField.getWidgets()[0];
      if (widget) {
        const rect = widget.getRectangle();
        info.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    } catch {
      /* widget geometry is optional */
    }
    if (field instanceof PDFTextField) {
      info.multiline = field.isMultiline();
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined) info.maxLength = maxLength;
    }
    if (field instanceof PDFDropdown || field instanceof PDFRadioGroup || field instanceof PDFOptionList) {
      try {
        info.options = field.getOptions();
      } catch {
        info.options = [];
      }
    }
    fields.push(info);
  }
  return fields;
}

function readValue(field: PDFField): string | boolean | string[] | null {
  try {
    if (field instanceof PDFTextField) return field.getText() ?? '';
    if (field instanceof PDFCheckBox) return field.isChecked();
    if (field instanceof PDFRadioGroup) return field.getSelected() ?? null;
    if (field instanceof PDFDropdown) return field.getSelected()[0] ?? null;
    if (field instanceof PDFOptionList) return field.getSelected();
    if (field instanceof PDFButton) return null;
    if (field instanceof PDFSignature) return null;
  } catch {
    return null;
  }
  return null;
}

export interface FillResult {
  filled: number;
  skipped: string[];
  errors: string[];
}

/** Applies form values from the UI, reporting fields that could not be filled. */
export function fillForm(doc: PDFDocument, values: Record<string, FillValue>, font?: PDFFont): FillResult {
  const form = doc.getForm();
  const result: FillResult = { filled: 0, skipped: [], errors: [] };
  for (const [name, payload] of Object.entries(values)) {
    let field: PDFField;
    try {
      field = form.getField(name);
    } catch {
      result.skipped.push(name);
      continue;
    }
    try {
      if (field instanceof PDFTextField && payload.type === 'text') {
        field.setText(String(payload.value));
      } else if (field instanceof PDFCheckBox && typeof payload.value === 'boolean') {
        if (payload.value) field.check();
        else field.uncheck();
      } else if ((field instanceof PDFRadioGroup || field instanceof PDFDropdown) && typeof payload.value === 'string') {
        field.select(payload.value);
      } else if (field instanceof PDFOptionList && (typeof payload.value === 'string' || Array.isArray(payload.value))) {
        field.select(Array.isArray(payload.value) ? payload.value : [payload.value]);
      } else {
        result.skipped.push(name);
        continue;
      }
      result.filled += 1;
    } catch (error) {
      result.errors.push(`${name}: ${(error as Error).message}`);
    }
  }
  try {
    form.updateFieldAppearances(font);
  } catch {
    /* appearance regeneration is best effort */
  }
  return result;
}

/** Flattens the AcroForm so the values become static content. */
export function flattenForm(doc: PDFDocument, font?: PDFFont): number {
  const form = doc.getForm();
  const count = form.getFields().length;
  if (!count) return 0;
  try {
    form.updateFieldAppearances(font);
  } catch {
    /* ignore appearance issues */
  }
  form.flatten({ updateFieldAppearances: false });
  // The interactive form no longer exists once flattened.
  doc.catalog.delete(PDFName.of('AcroForm'));
  return count;
}

/** Creates interactive form fields on existing pages. */
export function createFormFields(doc: PDFDocument, fields: FormCreateField[]): number {
  const form = doc.getForm();
  let created = 0;
  for (const field of fields) {
    if (field.pageIndex < 0 || field.pageIndex >= doc.getPageCount()) {
      throw appError('INVALID_INPUT', `Page ${field.pageIndex + 1} does not exist.`);
    }
    const page = doc.getPage(field.pageIndex);
    const options = { x: field.rect.x, y: field.rect.y, width: Math.max(8, field.rect.width), height: Math.max(8, field.rect.height), ...(field.required ? { required: true } : {}) };
    try {
      switch (field.kind) {
        case 'text': {
          const text = form.createTextField(field.name);
          if (field.multiline) text.enableMultiline();
          text.addToPage(page, options);
          break;
        }
        case 'checkbox': {
          form.createCheckBox(field.name).addToPage(page, options);
          break;
        }
        case 'radio': {
          form.createRadioGroup(field.name).addOptionToPage(field.options?.[0] ?? 'Option 1', page, options);
          break;
        }
        case 'dropdown': {
          const dropdown = form.createDropdown(field.name);
          dropdown.addOptions(field.options?.length ? field.options : ['Option 1']);
          dropdown.addToPage(page, options);
          break;
        }
      }
      created += 1;
    } catch (error) {
      throw appError('INVALID_INPUT', `Could not create the field "${field.name}": ${(error as Error).message}`);
    }
  }
  return created;
}

/** True when the document carries a digital signature dictionary. */
export function hasSignatureField(doc: PDFDocument): boolean {
  try {
    return doc.getForm().getFields().some((field) => field instanceof PDFSignature);
  } catch {
    return false;
  }
}
