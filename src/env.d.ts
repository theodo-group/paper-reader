// Bun lets you import an .html file as a server route handle.
declare module "*.html" {
  const html: import("bun").HTMLBundle;
  export default html;
}
