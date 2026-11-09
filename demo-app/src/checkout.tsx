// Sample source file used to demonstrate the read-only context tool.
export function CheckoutButton({ t }: { t: (key: string) => string }) {
  // TODO(localization): the Japanese copy for checkout.pay_now was reported as wrong by QA.
  return <button>{t('checkout.pay_now')}</button>;
}
