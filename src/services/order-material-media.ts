export function mediaKey(fileId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < fileId.length; index += 1) {
    hash = Math.imul(hash ^ fileId.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
