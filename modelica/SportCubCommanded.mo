// Commanded Sport Cub S2: the shared physics of the ACC 2027 paper
// (ACC_2027 methods/OEM.md, src/acc2027/fixed_wing_model.py), NED / FRD / ZYX Euler.
//
// Continuous part only. The per-interval discrete part of the paper's model is
// supplied through inputs and held over each 1/60 s interval:
//   u_*    delayed pilot sticks            [OEM-2]
//   s_eff  effective separation fraction   [OEM-5b]
//   dC*    bounded neural residual         [UDE-1]   (all zero = OEM)
// Default parameters: released OEM, airframe SC9. Regenerate with
// tools/export_reference.py.
model SportCubCommanded "Pilot sticks in, aircraft motion out"
  // Fixed aircraft constants
  parameter Real m = 0.063 "Mass [kg]";
  parameter Real S = 0.05553 "Wing area [m^2]";
  parameter Real b = 0.617 "Span [m]";
  parameter Real cbar = 0.09 "Mean chord [m]";
  parameter Real rho = 1.225 "Air density [kg/m^3]";
  parameter Real g = 9.81 "Gravity [m/s^2]";
  parameter Real Ixx = 6.9e-4;
  parameter Real Iyy = 6.0e-4;
  parameter Real Izz = 1.25e-3;
  parameter Real Ixz = 3.5e-5;
  parameter Real max_ail = 25.0*0.017453292519943295 "Full aileron throw [rad]";
  parameter Real max_elev = 23.0*0.017453292519943295 "Full elevator throw [rad]";
  parameter Real max_rud = 30.0*0.017453292519943295 "Full rudder throw [rad]";

  // Fixed separation priors
  parameter Real i_w = 0.14935036608647534 "Wing incidence in the mocap body frame [rad]";
  parameter Real CD0_flat = 0.379300848512235;
  parameter Real kY_flat = 0.504130517507679;

  // [OEM-5a] attached-flow forces
  parameter Real CL0 = 1.192;
  parameter Real CLa = 3.899;
  parameter Real CD0 = 0.02746;
  parameter Real CDCLS = 0.001187;
  parameter Real CYb = -1.298;
  parameter Real CYp = 0.7574;
  parameter Real CYr = 0.1733;
  parameter Real CYda = -0.02028;
  parameter Real CYdr = 0.2504;
  // [OEM-4] thrust
  parameter Real KT = 0.706 "Thrust scale (airframe bias)";
  parameter Real KTV = -1.0 "Thrust lapse with speed";
  parameter Real V_ref = 4.5;
  // [OEM-5c] angular-acceleration derivatives (per unit dynamic pressure)
  parameter Real KL0 = 0.3969;
  parameter Real KLb = -0.5208;
  parameter Real KLp = -10.7;
  parameter Real KLr = -4.721;
  parameter Real KLda = 0.0975;
  parameter Real KLdr = -1.234;
  parameter Real KM0 = -1.668;
  parameter Real KMa = -10.36;
  parameter Real KMq = -46.56;
  parameter Real KMe = -3.677;
  parameter Real KN0 = 0.1458;
  parameter Real KNb = 0.0273;
  parameter Real KNp = -5.351;
  parameter Real KNr = -6.047;
  parameter Real KNda = -0.3413;
  parameter Real KNdr = -1.558;
  // [OEM-4] motor torque
  parameter Real KLt = -16.51;
  parameter Real KLtd = -5.98;
  parameter Real KNt = -10.61;
  parameter Real tau_m = 0.0313 "Motor lag [s]";
  // [OEM-3] SAFE receiver map
  parameter Real k_aa = 0.5521;
  parameter Real k_ar = -0.6822;
  parameter Real k_aphi = -2.04;
  parameter Real k_ap = -0.9473;
  parameter Real k_ra = -0.06387;
  parameter Real k_rr = 0.8054;
  parameter Real k_rphi = -0.1406;
  parameter Real k_rrate = 0.1259;
  parameter Real k_ee = 4.118;
  parameter Real k_et = -0.7752;
  parameter Real k_etheta = 6.862;
  parameter Real k_eq = 2.353;
  parameter Real b_a = 0.1281 "Aileron trim (airframe bias)";
  parameter Real b_e = 1.197 "Elevator trim (airframe bias)";
  parameter Real b_r = 0.1708 "Rudder trim (airframe bias)";
  parameter Real tau_a = 0.0814 "Aileron lag [s]";
  parameter Real tau_e = 0.02 "Elevator lag [s]";
  parameter Real tau_r = 0.0562 "Rudder lag [s]";
  // [UDE-3] command filter (neural memory only)
  parameter Real tau_za = 0.1307 "Roll-stick filter time constant [s]";
  parameter Real tau_ze = 0.1307 "Pitch-stick filter time constant [s]";
  parameter Real tau_zt = 0.1307 "Throttle filter time constant [s]";
  parameter Real tau_zr = 0.1307 "Yaw-stick filter time constant [s]";

  // Initial state (measured state at the forecast start); one per line so the
  // site can rewrite them in place.
  parameter Real pN0 = 0;
  parameter Real pE0 = 0;
  parameter Real pD0 = 0;
  parameter Real u0 = 4.5;
  parameter Real v0 = 0;
  parameter Real w0 = 0;
  parameter Real phi0 = 0;
  parameter Real theta0 = 0;
  parameter Real psi0 = 0;
  parameter Real p0 = 0;
  parameter Real q0 = 0;
  parameter Real r0 = 0;
  parameter Real da0 = 0;
  parameter Real de0 = 0;
  parameter Real dr0 = 0;
  parameter Real Omega0 = 0.5;
  parameter Real za0 = 0;
  parameter Real ze0 = 0;
  parameter Real zt0 = 0.5;
  parameter Real zr0 = 0;

  // Inputs, held over each 1/60 s interval
  input Real u_a "Delayed roll stick";
  input Real u_e "Delayed pitch stick";
  input Real u_t "Delayed throttle stick";
  input Real u_r "Delayed yaw stick";
  input Real s_eff "Effective separation fraction [0..1]";
  input Real dCX, dCY, dCZ, dCl, dCm, dCn "Residual force / moment coefficients";

  // States
  Real pN(start = pN0, fixed = true), pE(start = pE0, fixed = true), pD(start = pD0, fixed = true);
  Real u(start = u0, fixed = true), v(start = v0, fixed = true), w(start = w0, fixed = true);
  Real phi(start = phi0, fixed = true), theta(start = theta0, fixed = true), psi(start = psi0, fixed = true);
  Real p(start = p0, fixed = true), q(start = q0, fixed = true), r(start = r0, fixed = true);
  Real da(start = da0, fixed = true), de(start = de0, fixed = true), dr(start = dr0, fixed = true);
  Real Omega(start = Omega0, fixed = true) "Motor speed, throttle units";
  Real za(start = za0, fixed = true), ze(start = ze0, fixed = true);
  Real zt(start = zt0, fixed = true), zr(start = zr0, fixed = true);

  // Outputs scored in the paper
  output Real V "Speed [m/s]";
  output Real alpha "Body incidence [rad]";
  output Real beta "Sideslip [rad]";
  output Real gamma "Flight-path angle [rad]";

protected
  parameter Real det = Ixx*Izz - Ixz*Ixz;
  parameter Real C1 = -(Izz*(Izz - Iyy) + Ixz*Ixz)/det;
  parameter Real C2 = Ixz*(Ixx - Iyy + Izz)/det;
  parameter Real C5 = (Izz - Ixx)/Iyy;
  parameter Real C6 = Ixz/Iyy;
  parameter Real C8 = ((Ixx - Iyy)*Ixx + Ixz*Ixz)/det;
  Real thr, Omega_dot, da_c, de_c, dr_c;
  Real Vt, qbar, ail, elev, rud, ps, qs, alpha_w, sep;
  Real CL_att, CD_att, CY_att, CL, CD, CY, L, D, Y, T;
  Real ca, sa, cb, sb, cphi, sphi, cth, sth, cpsi, spsi, cth_safe;
  Real FX, FY, FZ, MX, MY, MZ, aL, aM, aN, qsr;
  Real vN, vE, vD;
equation
  // [OEM-4] motor lag
  thr = max(u_t, 0);
  Omega_dot = (thr - Omega)/tau_m;
  der(Omega) = Omega_dot;

  // [OEM-3] receiver map -> saturated surface commands -> first-order surfaces
  da_c = min(1, max(-1, k_aa*u_a + k_ar*u_r + k_aphi*phi + k_ap*p + b_a));
  dr_c = min(1, max(-1, k_ra*u_a + k_rr*u_r + k_rphi*phi + k_rrate*r + b_r));
  de_c = min(1, max(-1, k_ee*u_e + k_et*(u_t - 0.5) + k_etheta*theta + k_eq*q + b_e));
  der(da) = (da_c - da)/tau_a;
  der(de) = (de_c - de)/tau_e;
  der(dr) = (dr_c - dr)/tau_r;

  // [UDE-3] command filter
  der(za) = (u_a - za)/tau_za;
  der(ze) = (u_e - ze)/tau_ze;
  der(zt) = (u_t - zt)/tau_zt;
  der(zr) = (u_r - zr)/tau_zr;

  // Air data
  Vt = min(12.0, max(0.5, sqrt(u*u + v*v + w*w + 1e-8)));
  alpha = atan2(w, u);
  beta = asin(min(0.99, max(-0.99, v/Vt)));
  qbar = 0.5*rho*Vt*Vt;
  ail = max_ail*da;
  elev = max_elev*de;
  rud = max_rud*dr;
  ps = b/(2*Vt);
  qs = cbar/(2*Vt);

  // [OEM-5a/5b] attached-flow forces blended to flat plate by s_eff
  alpha_w = alpha + i_w;
  sep = min(1, max(0, s_eff));
  CL_att = CL0 + CLa*alpha;
  CD_att = CD0 + CDCLS*CL_att*CL_att;
  CY_att = CYb*beta + CYp*ps*p + CYr*ps*r + CYda*ail + CYdr*rud;
  CL = (1 - sep)*CL_att + sep*2*sin(alpha_w)*cos(alpha_w);
  CD = (1 - sep)*CD_att + sep*(CD0_flat + 2*sin(alpha_w)*sin(alpha_w));
  CY = (1 - sep)*CY_att + sep*kY_flat*sin(beta)*cos(alpha_w);
  L = qbar*S*CL;
  D = qbar*S*CD;
  Y = qbar*S*CY;
  T = max(KT + KTV*(Vt - V_ref), 0)*m*thr;

  // Wind -> body, plus thrust and the residual force [UDE-1]
  ca = cos(alpha); sa = sin(alpha); cb = cos(beta); sb = sin(beta);
  FX = -D*ca*cb - Y*ca*sb + L*sa + T + qbar*S*dCX;
  FY = -D*sb + Y*cb + qbar*S*dCY;
  FZ = -D*sa*cb - Y*sa*sb - L*ca + qbar*S*dCZ;

  // [OEM-5c] translation
  cphi = cos(phi); sphi = sin(phi); cth = cos(theta); sth = sin(theta);
  cpsi = cos(psi); spsi = sin(psi);
  der(u) = FX/m - g*sth + r*v - q*w;
  der(v) = FY/m + g*sphi*cth + p*w - r*u;
  der(w) = FZ/m + g*cphi*cth + q*u - p*v;

  // [OEM-5c, OEM-4] nominal angular accelerations
  aL = qbar*(KL0 + KLb*beta + KLp*ps*p + KLr*ps*r + KLda*ail + KLdr*rud) + KLt*Omega + KLtd*Omega_dot;
  aM = qbar*(KM0 + KMa*alpha + KMq*qs*q + KMe*elev);
  aN = qbar*(KN0 + KNb*beta + KNp*ps*p + KNr*ps*r + KNda*ail + KNdr*rud) + KNt*Omega;

  // [UDE-1] residual moments through I^-1
  MX = qbar*S*b*dCl;
  MY = qbar*S*cbar*dCm;
  MZ = qbar*S*b*dCn;
  der(p) = C1*q*r + C2*p*q + aL + (Izz*MX + Ixz*MZ)/det;
  der(q) = C5*p*r + C6*(p*p - r*r) + aM + MY/Iyy;
  der(r) = C8*p*q - C2*q*r + aN + (Ixz*MX + Ixx*MZ)/det;

  // Euler kinematics with the 1/cos(theta) guard
  cth_safe = sign(cth)*max(abs(cth), 1e-3);
  qsr = q*sphi + r*cphi;
  der(phi) = p + sth/cth_safe*qsr;
  der(theta) = q*cphi - r*sphi;
  der(psi) = qsr/cth_safe;

  // Body -> NED position
  vN = cth*cpsi*u + (sphi*sth*cpsi - cphi*spsi)*v + (cphi*sth*cpsi + sphi*spsi)*w;
  vE = cth*spsi*u + (sphi*sth*spsi + cphi*cpsi)*v + (cphi*sth*spsi - sphi*cpsi)*w;
  vD = -sth*u + sphi*cth*v + cphi*cth*w;
  der(pN) = vN;
  der(pE) = vE;
  der(pD) = vD;

  V = sqrt(u*u + v*v + w*w);
  gamma = atan2(-vD, sqrt(vN*vN + vE*vE + 1e-8));
end SportCubCommanded;
