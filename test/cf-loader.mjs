import { register } from 'node:module';

const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:sockets') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        export function connect(address, options) {
          if (typeof globalThis.__mockConnect === 'function') {
            return globalThis.__mockConnect(address, options);
          }
          const chunks = [];
          const writable = new WritableStream({
            write(chunk) { chunks.push(chunk); }
          });
          const readable = new ReadableStream({
            start(controller) {
              controller.close();
            }
          });
          return {
            opened: Promise.resolve({ remoteAddress: address.hostname }),
            closed: new Promise(() => {}),
            writable,
            readable,
            close() {}
          };
        }
      \`),
    };
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);
