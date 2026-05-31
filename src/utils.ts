export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const getRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];