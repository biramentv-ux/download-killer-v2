# Download Killer Media Lab

Media Lab is an original TypeScript/JavaScript implementation for the Download Killer Cloudflare Worker and website.

## Upstream projects reviewed

### SaveHere

- Repository: `https://github.com/gudarzi/SaveHere`
- License: Apache License 2.0
- Relevant concepts reviewed:
  - direct HTTP/HTTPS download inspection;
  - filename extraction from `Content-Disposition`;
  - MIME and file-size inspection;
  - Range request detection for resumable downloads;
  - queue-oriented progress workflows.

No .NET/Blazor source file is embedded in the Worker. The Media Lab URL inspector is a new Cloudflare Worker implementation designed around the existing URL policy and SSRF protections.

### FluentDL

- Repository: `https://github.com/DerekYang2/FluentDL`
- License file reviewed: `FluentDL/LICENSE.txt` (MIT)
- Relevant concepts reviewed:
  - cross-source metadata matching;
  - reviewable match confidence;
  - duration-aware ranking;
  - metadata and quality inspection workflows.

No WinUI or service-download implementation is copied into the website. Media Lab uses an original deterministic scorer based on normalized title, artist, album, duration and source.

## Added endpoints

- `POST /api/media-lab/inspect`
- `POST /api/media-lab/rank`
- `GET /api/media-lab/about`

## Security boundaries

- Every initial URL and redirect is checked by the existing Download Killer URL policy.
- Only public HTTP/HTTPS URLs are accepted.
- Redirects are limited.
- Inspection requests use a strict timeout and fetch at most a one-byte Range response when HEAD is unavailable.
- The feature does not accept cookies, passwords, access tokens, CDM profiles, decryption keys or encrypted media streams.
- Matching operates only on metadata and public result URLs.

## Attribution

SaveHere is credited under Apache-2.0 and FluentDL under the MIT license. Their names identify the reviewed upstream projects and do not imply endorsement of Download Killer.
