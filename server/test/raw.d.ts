// Vite's `?raw` import: a fixture as the text it holds (the recorded NEAR AI streams are UTF-8).
declare module '*?raw' {
  const text: string;
  export default text;
}
