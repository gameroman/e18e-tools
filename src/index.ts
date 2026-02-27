#!/usr/bin/env bun

import fs from "node:fs/promises";

import pc from "picocolors";
import sade from "sade";
import semver from "semver";

import { fetchWithProgress } from "./utils/fetch-with-progress";
import { escapeMdTable } from "./utils/escape-md-table";

interface Args {
  pkg: string;
  number: number;
  file?: string;
  exclude?: string;
  dev: boolean;
  list?: boolean;
  recursive: number;
  depths: number;
  accumulate?: boolean;
}

let argv: Args;

sade("e18e-tools [pkg]", true)
  .option("--number, -n", "Number of dependents printed to stdout", 200)
  .option("--file, -f", "Write results as json to the specified file")
  .option(
    "--exclude, -e",
    "Exclude packages that include the specified string (can be comma separated)",
  )
  .option("--dev, -D", "Use devDependencies", false)
  .option(
    "--list, -l",
    "Only prints dependents as list to pipe into other commands",
  )
  .option(
    "--recursive, -r",
    "Gets x dependents recursively and prints sub tables",
    3,
  )
  .option("--depths, -d", "Number of recursion steps", 0)
  .action((pkg, opts) => (argv = { pkg, ...opts }))
  .parse(process.argv, {
    string: [
      // number
      "number",
      "recursive",
      "depths",
      // string
      "file",
      "exclude",
    ],
    boolean: ["dev", "list", "accumulate"],
  });

// If we don't run the app (e.g. just show help or version),
// we can just exit it gracefully.
if (!argv) {
  process.exit(0);
}

const npmRegistryBaseUrl = "https://registry.npmmirror.com";
const localCouchdbUrl = "https://npm.devminer.xyz/registry";

interface NpmPackageInfo {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  devDependencies?: Record<string, string>;
  repository?: {
    type: string;
    url: string;
  };
  dist?: {
    tarball: string;
    size: number;
  };
}

interface LocalDependendsResponseDev {
  total_rows: number;
  offset: number;

  rows: {
    id: string;
    key: string;
    value: string;
  }[];
}

interface LocalDependendsResponseProd {
  total_rows: number;
  offset: number;

  rows: {
    id: string;
    key: string;
    value: { name: string; version: string };
  }[];
}

interface DependentPackage {
  name: string;
  description?: string;
  maintainers?: {
    name: string;
  }[];
  distTags?: {
    latest: string;
  };
  lastPublish?: {
    maintainer: string;
    time: string;
  };
  version?: string;
}

function formatDownloads(downloads: number): string {
  if (downloads >= 1e9) return `${(downloads / 1e9).toFixed(2)}B`;
  if (downloads >= 1e6) return `${(downloads / 1e6).toFixed(2)}M`;
  if (downloads >= 1e3) return `${(downloads / 1e3).toFixed(2)}k`;
  return downloads.toString();
}

function formatTraffic(bytes: number): string {
  if (bytes >= 1e15) return `${(bytes / 1e15).toFixed(2)} PB`;
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes} bytes`;
}

async function fetchPackageInfo(
  packageName: string,
  version = "latest",
): Promise<NpmPackageInfo | null> {
  const url = `${npmRegistryBaseUrl}/${packageName}/${version}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const data = (await response.json()) as NpmPackageInfo;
    return data;
  } catch {
    return null;
  }
}

async function fetchDependents(packageName: string, dev = false) {
  const deps = dev ? "dev-dependencies" : "dependents2";
  const url = `${localCouchdbUrl}/_design/dependents/_view/${deps}?key="${packageName}"`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  const data = (await response.json()) as
    | LocalDependendsResponseDev
    | LocalDependendsResponseProd;

  if (data.rows.length && typeof data.rows[0].value === "string") {
    return data.rows.map((p) => {
      return {
        ...p,
        value: {
          name: p.id,
          version: "",
        },
      };
    });
  }

  return data.rows as LocalDependendsResponseProd["rows"];
}

async function fetchDownloadStats(packageNames: string[]) {
  type Stats = {
    total_rows: number;
    offset: number;
    rows: { id: string; key: string; value: number }[];
  };

  const response = await fetchWithProgress<Stats>(
    `${localCouchdbUrl}/_design/downloads/_view/downloads`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keys: packageNames }),
    },
  );

  const docs = response.rows.map((row) => [row.key, row.value]);

  return Object.fromEntries(docs);
}

const getPackageNameAndVersion = (
  inputPackage: string,
): [string, string | undefined] => {
  const scoped = inputPackage.startsWith("@");

  let [packageName, version] = inputPackage.split("@") as [
    string,
    string | undefined,
  ];

  if (scoped) {
    const atPosition = inputPackage.lastIndexOf("@");
    if (atPosition === 0) {
      packageName = inputPackage;
      version = undefined;
    } else {
      packageName = inputPackage.slice(0, atPosition);
      version = inputPackage.slice(atPosition + 1);
    }
  }

  return [packageName, version];
};

type Results = {
  name: string;
  downloads: number;
  traffic: number;
  isDevDependency: boolean;
  children: Results[];
  version: string;
};

function printOutput(results: Results[], dev = false) {
  results = results
    .filter(filterExcludes)
    .slice(0, argv.number)
    .slice(0, argv.depths ? argv.recursive || Infinity : Infinity);

  const maxIndexWidth = results.length.toString().length; // Width for indices

  const downloadsFormatted = results.map((p) => formatDownloads(p.downloads));
  const trafficFormatted = results.map((p) => formatTraffic(p.traffic));
  const maxDownloadsWidth = downloadsFormatted.reduce(
    (a, b) => Math.max(a, b.length),
    0,
  );
  const maxTrafficWidth = trafficFormatted.reduce(
    (a, b) => Math.max(a, b.length),
    0,
  );

  const maxVersionWidth = Math.min(
    results.reduce((a, b) => Math.max(a, b.version.length), 0),
    24,
  );

  if (!dev) {
    console.log(
      `\
| # | Downloads/month | Traffic | Version | Package |
|---|-----------------|---------|---------|---------|\
`,
    );
  } else {
    console.log(
      `\
| # | Downloads/month | Package |
|---|-----------------|---------|\
`,
    );
  }

  results.forEach((pkg, index) => {
    const indexStr = `${index + 1}`.padEnd(maxIndexWidth);
    const downloadsStr = formatDownloads(pkg.downloads).padStart(
      maxDownloadsWidth,
    );
    const trafficStr = pkg.traffic
      ? formatTraffic(pkg.traffic).padStart(maxTrafficWidth)
      : "".padStart(maxTrafficWidth);
    const versionStr = pkg.version.slice(0, 24).padEnd(maxVersionWidth);

    if (!dev) {
      console.log(
        escapeMdTable`| ${indexStr} | ${downloadsStr} | ${trafficStr} | ${versionStr} | [${pkg.name}](https://npmx.dev/${pkg.name}) |`,
      );
    } else {
      console.log(
        escapeMdTable`| ${indexStr} | ${downloadsStr} | [${pkg.name}](https://npmx.dev/${pkg.name}) |`,
      );
    }
  });
}

function accumulateStats(result: Results): number {
  return (
    result.children.reduce((a, b) => a + accumulateStats(b), 0) +
    result.downloads
  );
}

const filterExcludes = (pkg: DependentPackage) =>
  argv.exclude?.split(",").every((ex) => !pkg.name.includes(ex)) ?? true;

async function main(inputPackage: string, depths = 0) {
  const [packageName, version] = getPackageNameAndVersion(inputPackage);

  const packageInfo = await fetchPackageInfo(packageName, version);

  if (!packageInfo) {
    console.error(pc.red(`Failed to fetch package info for ${packageName}`));
    if (argv.recursive && argv.depths !== depths) {
      return [];
    }
    process.exit();
  }

  const actualVersion = packageInfo.version;

  const dependentsWithVersion = await fetchDependents(packageName, argv.dev);

  const dependents = dependentsWithVersion.filter((dependent) => {
    return (
      // Dont filter when no version was given
      !version || semver.satisfies(actualVersion, dependent.value.version)
    );
  });

  if (argv.list) {
    dependents.forEach((d) => {
      console.log(d.value);
    });
    return;
  }

  const downloadStats = await fetchDownloadStats(
    dependents.map((p) => p.value.name),
  );

  const results = dependents.map((dep): Results => {
    const downloads = downloadStats[dep.value.name] ?? 0;
    const traffic = downloads * (packageInfo.dist?.size ?? 0);

    return {
      name: dep.value.name,
      version: dep.value.version,
      downloads,
      traffic,
      isDevDependency: argv.dev ?? false,
      children: [],
    };
  });

  results.sort((a, b) => b.downloads - a.downloads);

  let topResults = results;
  if (argv.recursive && depths) {
    topResults = await Promise.all(
      results
        .filter(filterExcludes)
        .slice(0, argv.recursive)
        .map(async (r) => {
          const recursiveResults = await main(r.name, depths - 1);
          r.children = recursiveResults!;
          return r;
        }),
    );
  }

  if (depths !== argv.depths) {
    return topResults;
  }

  if (argv.file) {
    await fs.writeFile(argv.file, JSON.stringify(results, null, 2), "utf-8");
  }

  if (argv.accumulate) {
    topResults.forEach((result) => {
      result.downloads = accumulateStats(result);
      result.traffic = result.downloads * (packageInfo.dist?.size ?? 0);
      result.children = [];
    });

    topResults = topResults.sort((a, b) => b.downloads - a.downloads);
  }

  printOutput(topResults, argv.dev);
}

const inputPackage = argv.pkg;

if (!inputPackage) {
  console.error(pc.red("Please provide a package name as the first argument."));
  process.exit(1);
}

main(inputPackage, argv.depths).catch(console.error);
