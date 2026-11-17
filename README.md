<!-- SPDX-License-Identifier: MIT -->

# Git CORS Bridge

A browser extension that lets compatible websites clone, fetch and push Git repositories on GitHub, GitLab and other Git servers.

A browser normally lets a website read responses from another origin only if that server allows it.
Servers grant that permission through CORS headers (Cross-Origin Resource Sharing): extra information in their HTTP responses that tells the browser which origins may read them.

GitHub, GitLab.com and Codeberg do not provide the CORS support needed for these Git operations.
On a self-hosted instance, such as a university's GitLab, enabling that support generally requires a server administrator.
Without it, a website hosted elsewhere cannot clone, fetch or push directly from the browser.

This extension makes the requests for the website.
It only works on websites you enable, only connects to Git servers you approve for each website, and only forwards requests to Git smart HTTP endpoints.

Your browser's cookies for the Git server are never sent.
If authentication is required, the website must supply credentials, such as an access token.

## How this differs from a CORS proxy

A common workaround is a proxy such as [isomorphic-git's cors-proxy](https://github.com/isomorphic-git/cors-proxy): the website sends its Git requests to a server, which forwards them and adds the missing headers.
Someone has to run that server, and its operator can access the credentials and repository data passing through it.

With the extension, requests go from your browser straight to the Git server, without passing through a CORS proxy.
You still need to trust the website and the extension with the credentials and repository data they handle.
The extension's source is all in this repository.

## Installing

It isn't in the Chrome Web Store, Edge Add-ons or addons.mozilla.org yet.
Until then, download it from the [releases](https://github.com/nilssta/git-cors-bridge/releases):

- **Chrome, Edge:** download `git-cors-bridge-<version>-chrome.zip` and unzip it.
  Open `chrome://extensions` (`edge://extensions` in Edge), turn on developer mode, click **Load unpacked** and pick the unzipped folder.
  Keep the folder; the browser loads the extension from there.
- **Firefox:** if the release has a Mozilla-signed `.xpi` file, install it through `about:addons` → gear menu → **Install Add-on From File…**.
  Otherwise download `git-cors-bridge-<version>-firefox.zip`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on…** and pick the ZIP file.
  A temporary add-on is removed when Firefox restarts.
- **Safari:** not supported.

Then open a compatible website, click the extension's toolbar button and choose **Enable on this website**.
When the website first requests access to a Git server, the button shows a count; click it again and allow the server.

Remote websites and Git servers must use HTTPS.
HTTP is allowed for local development on `localhost` and `127.0.0.1`.
Redirects are not followed, so use the repository's current HTTPS clone URL.

## For website developers

Copy `client/client.js` into your site and pass its exported `http` object to isomorphic-git as the `http` option.

The client also provides `available()` to check whether the extension is enabled for your website, and `waitForApproval(server)` to wait for a pending server approval.
Retry the refused operation after approval.
See `client/client.d.ts` for the types.

`pnpm test` runs the tests against `git http-backend` in Chromium and Firefox, and `pnpm demo` opens an example page.

MIT licensed.
