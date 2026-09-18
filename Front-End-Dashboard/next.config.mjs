import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';

const nextConfig = {
	output: 'export',
	assetPrefix: isProd ? './' : undefined,
	images: {
		unoptimized: true,
	},
	/*
	 * Where the workspace starts.
	 *
	 * Without this Next infers it from the nearest lockfiles and finds three:
	 * this app's, the repo root's, and one in the user's HOME directory left by
	 * an npm install run in the wrong place. It picked the home directory,
	 * which is why the dev overlay reported an issue on every page load and the
	 * indicator sat permanently red.
	 *
	 * Pinning it here is the fix Next's own warning recommends, and it is the
	 * safe one: deleting a lockfile outside the project is not this config's
	 * business, and file tracing should be rooted at the app regardless of what
	 * else happens to sit above it on disk.
	 */
	outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
