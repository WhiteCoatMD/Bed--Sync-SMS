-- Sample inventory for testing
-- Replace 'DEALER_ID_HERE' with your actual dealer UUID after creating one

-- Budget range ($299-599)
INSERT INTO inventory (dealer_id, brand, model, series, size, firmness, type, price, sale_price, in_stock, quantity, features, description, financing_eligible, promotion) VALUES
('DEALER_ID_HERE', 'Restonic', 'ComfortCare', 'Essential', 'queen', 'medium', 'innerspring', 399.00, 349.00, true, 5, '{"Individually wrapped coils","Gel-infused foam top","10-year warranty"}', 'Great entry-level queen mattress with wrapped coils for motion isolation.', true, '$50 off this week'),
('DEALER_ID_HERE', 'Restonic', 'ComfortCare', 'Essential', 'king', 'medium', 'innerspring', 549.00, 499.00, true, 3, '{"Individually wrapped coils","Gel-infused foam top","10-year warranty"}', 'Spacious king size with excellent support and cooling gel.', true, '$50 off this week'),
('DEALER_ID_HERE', 'Restonic', 'ComfortCare', 'Essential', 'full', 'medium', 'innerspring', 349.00, 299.00, true, 4, '{"Individually wrapped coils","Gel-infused foam top","10-year warranty"}', 'Affordable full size with quality construction.', true, '$50 off this week'),
('DEALER_ID_HERE', 'Restonic', 'ComfortCare', 'Essential', 'twin', 'medium', 'innerspring', 249.00, NULL, true, 6, '{"Individually wrapped coils","Gel-infused foam top","10-year warranty"}', 'Perfect twin for kids rooms or guest beds.', true, NULL);

-- Mid range ($599-999)
INSERT INTO inventory (dealer_id, brand, model, series, size, firmness, type, price, sale_price, in_stock, quantity, features, description, financing_eligible, promotion) VALUES
('DEALER_ID_HERE', 'Serta', 'Perfect Sleeper', 'Trelleburg II', 'queen', 'medium_firm', 'hybrid', 799.00, 699.00, true, 4, '{"Hybrid coil + foam","Cool Twist Gel","Pressure relief","Anti-microbial"}', 'Best-selling hybrid queen with cooling tech and pressure relief.', true, 'Memorial Day: $100 off'),
('DEALER_ID_HERE', 'Serta', 'Perfect Sleeper', 'Trelleburg II', 'king', 'medium_firm', 'hybrid', 999.00, 899.00, true, 2, '{"Hybrid coil + foam","Cool Twist Gel","Pressure relief","Anti-microbial"}', 'Premium hybrid king with hotel-quality comfort.', true, 'Memorial Day: $100 off'),
('DEALER_ID_HERE', 'Beautyrest', 'Silver', 'BRS900', 'queen', 'firm', 'innerspring', 699.00, NULL, true, 3, '{"Pocketed coil","DualCool membrane","GelTouch foam"}', 'Firm support queen with advanced cooling technology.', true, NULL),
('DEALER_ID_HERE', 'Beautyrest', 'Silver', 'BRS900', 'queen', 'medium_soft', 'innerspring', 749.00, NULL, true, 2, '{"Pocketed coil","DualCool membrane","GelTouch foam","Pillow top"}', 'Plush pillow-top queen for side sleepers who like a softer feel.', true, NULL);

-- Premium ($999-1999)
INSERT INTO inventory (dealer_id, brand, model, series, size, firmness, type, price, sale_price, in_stock, quantity, features, description, financing_eligible, promotion) VALUES
('DEALER_ID_HERE', 'Tempur-Pedic', 'TEMPUR-Adapt', 'Medium', 'queen', 'medium', 'memory_foam', 1699.00, 1499.00, true, 2, '{"TEMPUR material","Motion cancellation","Washable cover","10-year warranty"}', 'Iconic Tempur-Pedic feel with advanced pressure relief.', true, 'Free pillows with purchase'),
('DEALER_ID_HERE', 'Tempur-Pedic', 'TEMPUR-Adapt', 'Medium', 'king', 'medium', 'memory_foam', 1999.00, 1799.00, true, 1, '{"TEMPUR material","Motion cancellation","Washable cover","10-year warranty"}', 'King-size luxury with the classic Tempur-Pedic adaptive feel.', true, 'Free pillows with purchase'),
('DEALER_ID_HERE', 'Purple', 'Purple Hybrid', 'Premier 3', 'queen', 'medium', 'hybrid', 1999.00, NULL, true, 2, '{"GelFlex Grid","Responsive support","Temperature neutral","Individually wrapped coils"}', 'No-pressure Purple Grid technology for all sleep positions.', true, NULL),
('DEALER_ID_HERE', 'Stearns & Foster', 'Estate', 'Rockwell', 'queen', 'firm', 'hybrid', 1799.00, 1599.00, true, 1, '{"IntelliCoil HD","Indulge HD Memory Foam","PrecisionEdge","Hand-tufted"}', 'Luxury hand-crafted mattress with superior edge support.', true, '$200 off this month');

-- Value / closeout
INSERT INTO inventory (dealer_id, brand, model, series, size, firmness, type, price, sale_price, in_stock, quantity, features, description, financing_eligible, promotion) VALUES
('DEALER_ID_HERE', 'Nectar', 'Classic', NULL, 'queen', 'medium_firm', 'memory_foam', 499.00, 399.00, true, 8, '{"CertiPUR-US foam","Cooling cover","Forever warranty","365-night trial"}', 'Online-favorite memory foam at a closeout price.', true, 'Clearance: $100 off'),
('DEALER_ID_HERE', 'Nectar', 'Classic', NULL, 'king', 'medium_firm', 'memory_foam', 649.00, 549.00, true, 5, '{"CertiPUR-US foam","Cooling cover","Forever warranty","365-night trial"}', 'King-size memory foam at an unbeatable clearance price.', true, 'Clearance: $100 off'),
('DEALER_ID_HERE', 'Ashley', 'Chime', '12-Inch', 'queen', 'medium', 'memory_foam', 349.00, NULL, true, 10, '{"12-inch profile","Gel memory foam","Hypoallergenic","CertiPUR-US"}', 'Budget-friendly gel memory foam queen. Great starter mattress.', true, NULL),
('DEALER_ID_HERE', 'Ashley', 'Chime', '12-Inch', 'twin', 'medium', 'memory_foam', 199.00, NULL, true, 8, '{"12-inch profile","Gel memory foam","Hypoallergenic","CertiPUR-US"}', 'Affordable twin memory foam. Perfect for kids.', true, NULL);
