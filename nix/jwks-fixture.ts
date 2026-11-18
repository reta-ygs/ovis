if (process.env["OVIS_MANAGED"] !== "0") {
  throw new Error("The installed Nix launcher must explicitly disable managed mode");
}

const path = process.env["OVIS_TEST_JWKS_FILE"];
if (!path) throw new Error("OVIS_TEST_JWKS_FILE is required");
const jwks = await Bun.file(path).json();

globalThis.fetch = Object.assign(async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://fixture.cloudflareaccess.com/cdn-cgi/access/certs") {
    throw new Error(`Unexpected network request in the Nix smoke fixture: ${url}`);
  }
  return Response.json(jwks);
}, { preconnect: globalThis.fetch.preconnect });
