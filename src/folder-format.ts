export function folderBytes(value: number) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = value,
    i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[i]}`;
}
