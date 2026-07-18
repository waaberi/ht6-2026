declare module 'exifr/dist/lite.esm.js' {
  type FormatOptions = boolean | { skip?: Array<string | number>; pick?: Array<string | number> };
  type Options = {
    tiff?: FormatOptions;
    exif?: FormatOptions;
    gps?: FormatOptions;
    interop?: FormatOptions;
    makerNote?: boolean;
    xmp?: FormatOptions;
    icc?: FormatOptions;
    iptc?: FormatOptions;
    jfif?: FormatOptions;
    mergeOutput?: boolean;
    sanitize?: boolean;
  };
  const exifr: { parse(data: ArrayBuffer | Uint8Array, options?: Options): Promise<Record<string, unknown> | undefined> };
  export default exifr;
}
