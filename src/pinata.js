export class PinataError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Keep the existing public-IPFS endpoints and their IpfsHash response contract.
export function createPinataClient(config, fetchImpl = fetch) {
  async function request(endpoint, body, extraHeaders = {}) {
    try {
      const response = await fetchImpl(
        `https://api.pinata.cloud/pinning/${endpoint}`,
        {
          method: "POST",
          headers: { ...config.pinataHeaders, ...extraHeaders },
          body,
          signal: AbortSignal.timeout(config.pinataTimeoutMs),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new PinataError(502, "Pinata upload failed");
      }
      const result = await response.json();
      if (!result || typeof result.IpfsHash !== "string" || !result.IpfsHash) {
        throw new PinataError(502, "Invalid response from Pinata");
      }
      return result;
    } catch (error) {
      if (error instanceof PinataError) throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new PinataError(504, "Pinata upload timed out");
      }
      // Do not expose upstream bodies, credentials, or internal errors to clients.
      throw new PinataError(502, "Pinata upload failed");
    }
  }

  return {
    uploadFile(file) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([file.buffer], { type: file.mimetype }),
        file.originalname,
      );
      body.append(
        "pinataMetadata",
        JSON.stringify({ name: file.originalname }),
      );
      return request("pinFileToIPFS", body);
    },
    uploadMetadata(metadata) {
      return request(
        "pinJSONToIPFS",
        JSON.stringify({ pinataContent: metadata }),
        {
          "Content-Type": "application/json",
        },
      );
    },
  };
}
