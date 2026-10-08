import { isIP } from "node:net";

export const isPublicAddress = (address: string) => {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    return (
      /^[23][0-9a-f]{3}:/.test(v) &&
      !/^(2001:(db8|0:|2:|1[0-9a-f]:|2[0-9a-f]:)|2002:|3fff:)/.test(v)
    );
  }
  return false;
};
