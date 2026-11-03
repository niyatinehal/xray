package billing

func (s *Service) Charge(ctx context.Context, o Order) error {
	_, err := s.stripe.PaymentIntents.New(&stripe.PaymentIntentParams{Amount: o.Total})
	return err
}
