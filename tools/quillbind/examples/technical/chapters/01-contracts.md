---
id: contracts
title: Clear Contracts
lang: en
---

# Clear Contracts

A contract states what a module accepts and what its callers can rely on. The code remains readable when readers choose a larger font.[^contract]

## A small function {#function}

```typescript caption="Listing 1. An exact, copyable implementation"
export function square(value: number): number {
  return value * value;
}
```

The expression $x^2$ preserves its mathematical structure. A display equation states a related identity:

$$
(a+b)^2 = a^2 + 2ab + b^2
$$

::caption[Inputs and expected results]

| Input | Output | Meaning            |
| ----- | ------ | ------------------ |
| 2     | 4      | A positive integer |
| -3    | 9      | A negative integer |

:::admonition{title="Keep the contract small"}
Use explicit inputs and outputs. Side effects belong at the application boundary.
:::

:::definition{term="Invariant"}
A property that remains true across a permitted transformation.
:::

The next chapter describes [verification](02-verification.md#verification).

[^contract]: A contract describes observable behavior. It need not expose every implementation detail.
