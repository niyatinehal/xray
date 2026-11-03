package orders

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	order, err := h.repo.Insert(ctx, req)
	if err != nil { return }
	h.billing.Charge(ctx, order)
	h.nats.Publish("orders.created", order.ID)
}
