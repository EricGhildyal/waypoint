"use client";

/** Small shared helpers for the Formik + Yup forms. */

import * as Yup from "yup";

interface FieldMetaSource {
  getFieldMeta: (name: string) => { touched: boolean; error?: string };
}

/** Touched-gated Yup error for a field (supports nested paths like "models.planning"). */
export function fieldError(formik: FieldMetaSource, name: string): string | null {
  const meta = formik.getFieldMeta(name);
  return meta.touched && meta.error ? meta.error : null;
}

export function ErrorText({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-red-400">{children}</p>;
}

/** Yup transform: HTML inputs yield "" — persist those as null. */
export const emptyToNull = (value: unknown, original: unknown): unknown =>
  original === "" ? null : value;

const urlSchema = Yup.string().url();

/**
 * Like `Yup.string().url(message)`, but lets any localhost URL through: Yup's
 * url regex requires a dotted hostname, so `http://localhost:3000` — the normal
 * value for these fields during local development — fails it. Emptiness is left
 * to whatever `required()` / `nullable()` the caller chains on.
 */
export const urlOrLocalhost = (message: string) =>
  Yup.string().test("url-or-localhost", message, (value) => {
    if (!value) return true;
    if (value.includes("localhost")) return true;
    return urlSchema.isValidSync(value);
  });
