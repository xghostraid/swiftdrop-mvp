# SwiftDrop MVP

This is a working MVP generated from `SwiftDrop_System_Design.docx`.

## Includes

- Sender booking flow
- Driver auto-matching simulation (2km -> 5km -> 10km)
- Delivery status progression (Matched -> Picked Up -> In Transit -> Delivered)
- Courier class selection (bike, car, van, truck)
- ASAP and scheduled deliveries
- Multi-stop booking
- Transparent fare breakdown and operations stats dashboard
- Driver app simulator with online/offline toggle
- 15-second offer timer with accept/decline and rebroadcast logic
- Driver wallet and payout crediting on completed jobs

## Run

```bash
cd /Users/xace56/Downloads/swiftdrop-mvp
npm install
npm run dev
```

Open: `http://localhost:3000`
UX mockup flow: `http://localhost:3000/mockup.html`

## Notes

- Data is stored in memory (resets on restart).
- This is a functional prototype, not production-ready.
- Product direction is inspired by operational patterns common in Lalamove, Borzo, GoShare, and Stuart (without copying proprietary logic).
